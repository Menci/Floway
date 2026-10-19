import { klona } from 'klona/json';

import { roundTripAssistantTurn, warnDroppedUnrecognizedAssistantReasoning } from '../../../round-trip/resolve.ts';
import { TranslatorInputError } from '../../../translator-input-error.ts';
import type { SidecarCodec } from '../../../types.ts';
import { filterAnthropicMessagesClientTools } from '../as-source/client-tools.ts';
import { partitionAnthropicMessagesTurns } from '../as-source/conversation-turns.ts';
import { collectAnthropicMessagesReplayContents, findAnthropicMessagesSidecarCarriers, verifyAnthropicMessagesTurnDigest } from '../as-source/round-trip.ts';
import type {
  AnthropicMessagesAssistantContentBlock,
  AnthropicMessagesAssistantMessage,
  AnthropicMessagesClientTool,
  AnthropicMessagesPayload,
  AnthropicMessagesServerToolUseBlockParam,
  AnthropicMessagesSystemMessage,
  AnthropicMessagesTextBlockParam,
  AnthropicMessagesToolResultBlock,
  AnthropicMessagesToolUseBlockParam,
  AnthropicMessagesUserContentBlock,
  AnthropicMessagesUserMessage,
} from '@floway-dev/protocols/anthropic-messages';
import { FAST_SERVICE_TIER } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsStreamOptionsEx, OpenAIChatCompletionsTextPart, OpenAIChatCompletionsUserContentPart, OpenAIChatCompletionsPayload, OpenAIChatCompletionsMessage, OpenAIChatCompletionsTool, OpenAIChatCompletionsToolCall } from '@floway-dev/protocols/openai-chat-completions';

const flattenToolResultContent = (content: AnthropicMessagesToolResultBlock['content']): string => {
  if (content === undefined) return '';
  if (typeof content === 'string') return content;

  const textBlocks = content.filter((block): block is AnthropicMessagesTextBlockParam => block.type === 'text');
  if (textBlocks.length === content.length) return textBlocks.map(block => block.text).join('\n\n');

  return JSON.stringify(content);
};

// OpenAI strict-mode JSON Schema validators reject an object schema without an
// explicit `properties` field. Preserve the source schema while satisfying that
// target requirement.
// https://github.com/caozhiyuan/copilot-api/commit/ad57069826843c5d17d7b0e5ef2f75050128893c
const normalizeToolInputSchema = (schema: Record<string, unknown>): Record<string, unknown> => {
  const target = klona(schema);
  if (target.type !== 'object' || target.properties !== undefined) return target;
  return { ...target, properties: {} };
};

// The Chat Completions effort axis combines Anthropic's separate effort and
// thinking controls; token budgets remain a separate quantity.
const resolveReasoningEffort = (payload: AnthropicMessagesPayload): string | undefined => {
  if (payload.output_config?.effort != null) return payload.output_config.effort;
  if (payload.thinking?.type === 'disabled') return 'none';
  if (payload.thinking?.type === 'enabled' || payload.thinking?.type === 'adaptive') return 'medium';
  return undefined;
};

const toOpenAIChatCompletionsContent = (content: string | AnthropicMessagesUserContentBlock[] | AnthropicMessagesAssistantContentBlock[]): string | OpenAIChatCompletionsUserContentPart[] => {
  if (typeof content === 'string') return content;

  if (!content.some(block => block.type === 'image')) {
    return content
      .filter((block): block is AnthropicMessagesTextBlockParam => block.type === 'text')
      .map(block => block.text)
      .join('\n\n');
  }

  const parts: OpenAIChatCompletionsUserContentPart[] = [];

  for (const block of content) {
    if (block.type === 'text') {
      parts.push({ type: 'text', text: block.text });
      continue;
    }

    if (block.type === 'image') {
      if (block.source.type === 'file') throw new TranslatorInputError('Cannot translate file_id-only Anthropic image input to Chat Completions.');
      parts.push({ type: 'image_url', image_url: { url: block.source.type === 'url' ? block.source.url : `data:${block.source.media_type};base64,${block.source.data}` } });
    }
  }

  return parts;
};

const toOpenAIChatCompletionsFunctionCall = (block: AnthropicMessagesToolUseBlockParam | AnthropicMessagesServerToolUseBlockParam): OpenAIChatCompletionsToolCall => ({
  id: block.id,
  type: 'function',
  function: {
    name: block.name,
    arguments: JSON.stringify(block.input),
  },
});

type PendingAssistantMessage = {
  textParts: string[];
  toolCalls: OpenAIChatCompletionsToolCall[];
  reasoningText: string[];
};

const flushPendingAssistantMessage = (messages: OpenAIChatCompletionsMessage[], pending: PendingAssistantMessage): void => {
  if (pending.textParts.length === 0 && pending.toolCalls.length === 0 && pending.reasoningText.length === 0) {
    return;
  }

  messages.push({
    role: 'assistant',
    content: pending.textParts.join('\n\n') || null,
    ...(pending.toolCalls.length > 0 ? { tool_calls: [...pending.toolCalls] } : {}),
    ...(pending.reasoningText.length > 0 ? { reasoning_text: pending.reasoningText.join('') } : {}),
  });

  pending.textParts.length = 0;
  pending.toolCalls.length = 0;
  pending.reasoningText.length = 0;
};

const translateAnthropicMessagesUser = (message: AnthropicMessagesUserMessage, messageIdx: number, legacyFunctionNames: Map<string, string>): OpenAIChatCompletionsMessage[] => {
  if (!Array.isArray(message.content)) {
    return [
      {
        role: 'user',
        content: message.content,
      },
    ];
  }

  const messages: OpenAIChatCompletionsMessage[] = [];
  const pendingUserBlocks: Exclude<AnthropicMessagesUserContentBlock, AnthropicMessagesToolResultBlock>[] = [];

  const flushPendingUserBlocks = () => {
    if (pendingUserBlocks.length === 0) return;
    messages.push({
      role: 'user',
      content: toOpenAIChatCompletionsContent(pendingUserBlocks),
    });

    pendingUserBlocks.length = 0;
  };

  for (const [blockIdx, block] of message.content.entries()) {
    if (block.type === 'tool_result') {
      // Preserving source chronology matters more than keeping one OpenAI Chat Completions message,
      // so interleaved user content and tool results become alternating messages.
      flushPendingUserBlocks();
      const content = flattenToolResultContent(block.content);
      const legacyName = legacyFunctionNames.get(block.tool_use_id);
      legacyFunctionNames.delete(block.tool_use_id);
      messages.push(legacyName === undefined
        ? { role: 'tool', tool_call_id: block.tool_use_id, content }
        : { role: 'function', name: legacyName, content });
      continue;
    }

    if (block.type !== 'text' && block.type !== 'image') {
      throw new TranslatorInputError(`messages.${messageIdx}.content.${blockIdx}.type: '${(block as { type: string }).type}' content blocks are not supported on this model`);
    }

    pendingUserBlocks.push(block);
  }

  flushPendingUserBlocks();

  return messages;
};

const translateAnthropicMessagesAssistant = (message: AnthropicMessagesAssistantMessage, messageIdx: number): OpenAIChatCompletionsMessage[] => {
  if (!Array.isArray(message.content)) {
    return [
      {
        role: 'assistant',
        content: message.content,
      },
    ];
  }

  const messages: OpenAIChatCompletionsMessage[] = [];
  const pending: PendingAssistantMessage = {
    textParts: [],
    toolCalls: [],
    reasoningText: [],
  };

  for (const [blockIdx, block] of message.content.entries()) {
    switch (block.type) {
    case 'text':
      pending.textParts.push(block.text);
      break;
    case 'thinking':
      if (block.thinking !== '') pending.reasoningText.push(block.thinking);
      break;
    case 'redacted_thinking':
      warnDroppedUnrecognizedAssistantReasoning('anthropicMessages', 'openaiChatCompletions');
      break;
    case 'tool_use':
    case 'server_tool_use':
      pending.toolCalls.push(toOpenAIChatCompletionsFunctionCall(block));
      break;
    case 'web_search_tool_result':
      flushPendingAssistantMessage(messages, pending);
      messages.push({
        role: 'tool',
        tool_call_id: block.tool_use_id,
        content: JSON.stringify(block.content),
      });
      break;
    default:
      throw new TranslatorInputError(`messages.${messageIdx}.content.${blockIdx}.type: '${(block as { type: string }).type}' assistant content blocks are not supported on this model`);
    }
  }

  flushPendingAssistantMessage(messages, pending);
  return messages;
};

// Anthropic Messages system blocks are prompt boundaries; preserve each one
// as a separate OpenAI Chat Completions text part so a CC→Anthropic Messages→CC round trip
// does not silently merge them. Falls back to the simple string form when
// the source is already a single-string field.
const systemContentFromBlocks = (system: string | AnthropicMessagesTextBlockParam[]): string | OpenAIChatCompletionsTextPart[] =>
  typeof system === 'string'
    ? system
    : system.map(block => ({ type: 'text', text: block.text }));

const translateAnthropicMessagesSystem = (message: AnthropicMessagesSystemMessage): OpenAIChatCompletionsMessage[] => [
  {
    role: 'system',
    content: typeof message.content === 'string' ? message.content : message.content.map(block => {
      if (block.type !== 'text') throw new TranslatorInputError('Only text is supported in Chat system messages.');
      return { type: 'text', text: block.text };
    }),
  },
];

const translateAnthropicMessagesTools = (tools?: AnthropicMessagesClientTool[]): OpenAIChatCompletionsTool[] | undefined =>
  // Do not hide target-side function-name constraints by renaming tools here;
  // the Anthropic Messages source contract has no reverse mapping surface for that.
  tools?.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: normalizeToolInputSchema(tool.input_schema),
      ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
    },
  }));

const translateAnthropicMessagesToolChoice = (toolChoice?: AnthropicMessagesPayload['tool_choice'], tools?: AnthropicMessagesClientTool[]): OpenAIChatCompletionsPayload['tool_choice'] => {
  if (!toolChoice) return undefined;
  if (!tools || tools.length === 0) {
    if (toolChoice.type === 'tool') throw new TranslatorInputError(`Anthropic Messages tool_choice names an undeclared tool: ${String(toolChoice.name)}`);
    return undefined;
  }

  switch (toolChoice.type) {
  case 'auto':
    return 'auto';
  case 'any':
    return 'required';
  case 'tool': {
    if (!toolChoice.name || !tools.some(tool => tool.name === toolChoice.name)) throw new TranslatorInputError(`Anthropic Messages tool_choice names an undeclared tool: ${String(toolChoice.name)}`);
    return { type: 'function', function: { name: toolChoice.name } };
  }
  case 'none':
    return 'none';
  }
};

export const buildTargetRequest = async (
  payload: AnthropicMessagesPayload,
  codec: SidecarCodec,
): Promise<OpenAIChatCompletionsPayload> => {
  const clientTools = filterAnthropicMessagesClientTools(payload.tools);
  const legacyFunctionNames = new Map<string, string>();
  // Pass effort through verbatim; per-upstream enum acceptance (e.g. some
  // backends rejecting `xhigh`/`max`) is the target interceptor's concern.
  const reasoningEffort = resolveReasoningEffort(payload);
  // Anthropic's structured-output schema is already strict. Supply the name
  // required by OpenAI and let OpenAI report any schema constraint it rejects.
  // https://platform.claude.com/docs/en/build-with-claude/structured-outputs
  const format = payload.output_config?.format;
  const jsonSchema = format?.type === 'json_schema'
    ? { name: 'messages_response', strict: true as const, schema: klona(format.schema) }
    : undefined;
  const responseFormat = jsonSchema ? { type: 'json_schema' as const, json_schema: jsonSchema } : undefined;

  // Anthropic `speed: 'fast'` selects OpenAI's priority lane. Without an
  // explicit speed, preserve Anthropic's service tier as an open string.
  // https://docs.claude.com/en/build-with-claude/fast-mode
  // https://platform.openai.com/docs/guides/fast-mode
  const serviceTier = payload.speed === 'fast' ? FAST_SERVICE_TIER : payload.speed === undefined ? payload.service_tier : undefined;
  const messages: OpenAIChatCompletionsMessage[] = payload.system == null || (typeof payload.system === 'string' ? payload.system === '' : payload.system.length === 0)
    ? []
    : [{ role: 'system', content: systemContentFromBlocks(payload.system) }];
  let messageIndex = 0;
  for (const turn of partitionAnthropicMessagesTurns(payload.messages)) {
    if (turn.role === 'assistant') {
      const roundTrip = await roundTripAssistantTurn('anthropicMessages', 'openaiChatCompletions', turn.items, codec, findAnthropicMessagesSidecarCarriers, verifyAnthropicMessagesTurnDigest, collectAnthropicMessagesReplayContents);
      if (roundTrip?.turn.function_call != null) {
        const modernIds = new Set(roundTrip.turn.tool_calls?.map(call => call.id));
        for (const message of turn.items) if (Array.isArray(message.content)) for (const block of message.content) {
          if ((block.type === 'tool_use' || block.type === 'server_tool_use') && !modernIds.has(block.id)) legacyFunctionNames.set(block.id, roundTrip.turn.function_call.name);
        }
      }
      messages.push(...(roundTrip ? [roundTrip.turn] : turn.items.flatMap((message, index) => translateAnthropicMessagesAssistant(message, messageIndex + index))));
    } else for (const [index, message] of turn.items.entries()) {
      switch (message.role) {
      case 'user': messages.push(...translateAnthropicMessagesUser(message, messageIndex + index, legacyFunctionNames)); break;
      case 'system': messages.push(...translateAnthropicMessagesSystem(message)); break;
      default: throw new TranslatorInputError(`messages.${messageIndex + index}.role: role '${(message as { role: string }).role}' is not supported on this model`);
      }
    }
    messageIndex += turn.items.length;
  }

  return {
    model: payload.model,
    messages,
    ...(reasoningEffort !== undefined ? { reasoning_effort: reasoningEffort } : {}),
    max_tokens: payload.max_tokens,
    stop: klona(payload.stop_sequences),
    stream: true,
    // Ask the upstream for usage on every streaming chunk, not just the final
    // one. `include_usage` is the OpenAI-standard flag; `continuous_usage_stats`
    // is the vLLM/SGLang extension that lets this translation emit the real
    // `input_tokens` in `message_start` (before any output exists) and
    // cumulative `output_tokens` on intermediate `message_delta` events, which
    // is the shape the Anthropic Messages SSE contract promises. Upstreams that
    // do not implement the extension ignore it, and the translator falls back
    // to the final usage-only chunk. Ref:
    // https://github.com/vllm-project/vllm/blob/d5f0a6e829faa69d1db289bf62b14dae136c02b2/vllm/entrypoints/generate/base/protocol.py#L241-L243
    stream_options: { include_usage: true, continuous_usage_stats: true } as OpenAIChatCompletionsStreamOptionsEx,
    temperature: payload.temperature,
    top_p: payload.top_p,
    tools: translateAnthropicMessagesTools(clientTools),
    tool_choice: translateAnthropicMessagesToolChoice(payload.tool_choice, clientTools),
    ...(responseFormat ? { response_format: responseFormat } : {}),
    ...(serviceTier !== undefined ? { service_tier: serviceTier } : {}),
  };
};
