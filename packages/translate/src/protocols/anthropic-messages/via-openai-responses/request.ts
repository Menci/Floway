import { klona } from 'klona/json';

import { anthropicMessagesReasoningBlockToOpenAIResponsesReasoning } from './reasoning.ts';
import { roundTripAssistantTurn, warnDroppedUnrecognizedAssistantReasoning } from '../../../round-trip/resolve.ts';
import { TranslatorInputError } from '../../../translator-input-error.ts';
import type { SidecarCodec } from '../../../types.ts';
import { filterAnthropicMessagesClientTools } from '../as-source/client-tools.ts';
import { partitionAnthropicMessagesTurns } from '../as-source/conversation-turns.ts';
import { collectAnthropicMessagesReplayContents, findAnthropicMessagesSidecarCarriers, verifyAnthropicMessagesTurnDigest } from '../as-source/round-trip.ts';
import {
  type AnthropicMessagesAssistantMessage,
  type AnthropicMessagesClientTool,
  type AnthropicMessagesPayload,
  type AnthropicMessagesMetadataEx,
  type AnthropicMessagesServerToolUseBlockParam,
  type AnthropicMessagesSystemMessage,
  type AnthropicMessagesTextBlockParam,
  type AnthropicMessagesToolResultBlock,
  type AnthropicMessagesToolUseBlockParam,
  type AnthropicMessagesUserContentBlock,
  type AnthropicMessagesUserMessage,
  type AnthropicMessagesWebSearchToolResultBlockParam,
} from '@floway-dev/protocols/anthropic-messages';
import { FAST_SERVICE_TIER } from '@floway-dev/protocols/common';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesInputContent, CanonicalOpenAIResponsesInputItem, OpenAIResponsesTool, OpenAIResponsesToolChoice } from '@floway-dev/protocols/openai-responses';

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

// The Responses effort axis combines Anthropic's separate effort and thinking
// controls; token budgets remain a separate quantity.
const resolveReasoningEffort = (payload: AnthropicMessagesPayload): string | undefined => {
  if (payload.output_config?.effort != null) return payload.output_config.effort;
  if (payload.thinking?.type === 'disabled') return 'none';
  if (payload.thinking?.type === 'enabled' || payload.thinking?.type === 'adaptive') return 'medium';
  return undefined;
};

const flushPendingContent = (pending: OpenAIResponsesInputContent[], input: CanonicalOpenAIResponsesInputItem[], role: 'user' | 'assistant'): void => {
  if (pending.length === 0) return;
  input.push({ type: 'message', role, content: [...pending] });
  pending.length = 0;
};

const translateUserContentBlock = (
  block: Exclude<AnthropicMessagesUserContentBlock, AnthropicMessagesToolResultBlock>,
  messageIdx: number,
  blockIdx: number,
): OpenAIResponsesInputContent => {
  if (block.type === 'text') return { type: 'input_text', text: block.text };
  if (block.type === 'image') {
    if (block.source.type === 'file') return { type: 'input_image', file_id: block.source.file_id };
    if (block.source.type === 'url') return { type: 'input_image', image_url: block.source.url };
    return {
      type: 'input_image',
      image_url: `data:${block.source.media_type};base64,${block.source.data}`,
    };
  }

  throw new TranslatorInputError(`messages.${messageIdx}.content.${blockIdx}.type: '${(block as { type: string }).type}' user content blocks are not supported on this model`);
};

const toOpenAIResponsesFunctionCall = (block: AnthropicMessagesToolUseBlockParam | AnthropicMessagesServerToolUseBlockParam): CanonicalOpenAIResponsesInputItem => ({
  type: 'function_call',
  call_id: block.id,
  name: block.name,
  arguments: JSON.stringify(block.input),
  status: 'completed',
});

const toOpenAIResponsesStructuredToolOutput = (block: AnthropicMessagesWebSearchToolResultBlockParam): Extract<CanonicalOpenAIResponsesInputItem, { type: 'function_call_output' }> => ({
  type: 'function_call_output',
  call_id: block.tool_use_id,
  output: JSON.stringify(block.content),
  status: Array.isArray(block.content) ? 'completed' : 'incomplete',
});

const translateUserMessage = (message: AnthropicMessagesUserMessage, messageIdx: number): CanonicalOpenAIResponsesInputItem[] => {
  if (typeof message.content === 'string') {
    return [{ type: 'message', role: 'user', content: message.content }];
  }

  const input: CanonicalOpenAIResponsesInputItem[] = [];
  const pendingContent: OpenAIResponsesInputContent[] = [];

  for (const [blockIdx, block] of message.content.entries()) {
    if (block.type === 'tool_result') {
      // OpenAI Responses can represent alternating user content and tool outputs, so
      // preserve Anthropic Messages block chronology instead of moving all tool results to
      // the front of the turn.
      flushPendingContent(pendingContent, input, 'user');
      input.push({
        type: 'function_call_output',
        call_id: block.tool_use_id,
        output: flattenToolResultContent(block.content),
        status: block.is_error ? 'incomplete' : 'completed',
      });
      continue;
    }

    pendingContent.push(translateUserContentBlock(block, messageIdx, blockIdx));
  }

  flushPendingContent(pendingContent, input, 'user');
  return input;
};

const translateAssistantMessage = (message: AnthropicMessagesAssistantMessage, messageIdx: number): CanonicalOpenAIResponsesInputItem[] => {
  if (typeof message.content === 'string') {
    return [{ type: 'message', role: 'assistant', content: message.content }];
  }

  const input: CanonicalOpenAIResponsesInputItem[] = [];
  const pendingContent: OpenAIResponsesInputContent[] = [];

  for (const [blockIdx, block] of message.content.entries()) {
    if (block.type === 'tool_use' || block.type === 'server_tool_use') {
      flushPendingContent(pendingContent, input, 'assistant');
      input.push(toOpenAIResponsesFunctionCall(block));
      continue;
    }

    if (block.type === 'web_search_tool_result') {
      flushPendingContent(pendingContent, input, 'assistant');
      input.push(toOpenAIResponsesStructuredToolOutput(block));
      continue;
    }

    if (block.type === 'redacted_thinking') {
      warnDroppedUnrecognizedAssistantReasoning('anthropicMessages', 'openaiResponses');
      continue;
    }

    if (block.type === 'thinking') {
      flushPendingContent(pendingContent, input, 'assistant');
      const reasoning = anthropicMessagesReasoningBlockToOpenAIResponsesReasoning(block);
      if (reasoning !== null) input.push(reasoning);
      continue;
    }

    if (block.type === 'text') {
      pendingContent.push({ type: 'output_text', text: block.text });
      continue;
    }

    throw new TranslatorInputError(`messages.${messageIdx}.content.${blockIdx}.type: '${(block as { type: string }).type}' assistant content blocks are not supported on this model`);
  }

  flushPendingContent(pendingContent, input, 'assistant');
  return input;
};

// Preserve per-block boundaries when the source carries a
// AnthropicMessagesTextBlockParam[]; single-string source stays as string content.
const translateAnthropicMessagesSystem = (message: AnthropicMessagesSystemMessage): CanonicalOpenAIResponsesInputItem[] => [
  {
    type: 'message',
    role: 'system',
    content: typeof message.content === 'string'
      ? message.content
      : message.content.map(block => {
          if (block.type !== 'text') throw new TranslatorInputError('Only text system content is supported by this Responses translation.');
          return { type: 'input_text', text: block.text };
        }),
  },
];

// OpenAI Responses' `instructions` field is `string | null` — it cannot carry
// multiple text blocks faithfully. When the source `AnthropicMessagesPayload.system`
// is a single string or a single block, the canonical `instructions` slot
// is the right home. When the source is a multi-block array, the canonical
// slot would silently merge the boundaries, so emit a leading input
// system message with multi-part `input_text` content instead and leave
// `instructions` null; both placements act as a system prompt prefix at
// the upstream and the multi-part form preserves the caller-visible block
// structure.
interface SystemPlacement {
  readonly instructions: string | null;
  readonly prependItems: readonly CanonicalOpenAIResponsesInputItem[];
}

const placeAnthropicMessagesSystem = (system: string | AnthropicMessagesTextBlockParam[] | undefined): SystemPlacement => {
  if (typeof system === 'string') return { instructions: system, prependItems: [] };
  if (!system || system.length === 0) return { instructions: null, prependItems: [] };
  if (system.length === 1) return { instructions: system[0].text, prependItems: [] };
  return {
    instructions: null,
    prependItems: [{
      type: 'message',
      role: 'system',
      content: system.map(block => ({ type: 'input_text', text: block.text })),
    }],
  };
};

const translateTools = (tools: AnthropicMessagesClientTool[] | undefined): OpenAIResponsesTool[] => {
  if (!tools || tools.length === 0) return [];

  return tools.map(tool => ({
    type: 'function',
    name: tool.name,
    parameters: normalizeToolInputSchema(tool.input_schema),
    // OpenAI Responses tools default stricter than Anthropic/OpenAI-Chat-Completions-style function tools,
    // so omitted source strictness is made explicit as false.
    strict: tool.strict ?? false,
    ...(tool.description ? { description: tool.description } : {}),
  }));
};

// OpenAI Responses upstreams disagree on an orphaned `tool_choice` — one sent without
// tools: OpenAI-backed models ignore it, while xAI-backed ones reject the
// request with `invalid-argument: A tool_choice was set on the request but no
// tools were specified`. Other gateways hit the same wall on both the native
// OpenAI Responses path and the OpenAI Responses → OpenAI Chat Completions path:
// https://github.com/Wei-Shaw/sub2api/issues/4819
// https://github.com/jlcodes99/cockpit-tools/issues/1727
const translateToolChoice = (toolChoice: AnthropicMessagesPayload['tool_choice'], tools?: AnthropicMessagesClientTool[]): OpenAIResponsesToolChoice | undefined => {
  if (!toolChoice) return undefined;
  if (!tools || tools.length === 0) {
    if (toolChoice.type === 'tool') throw new TranslatorInputError(`Anthropic Messages tool_choice names an undeclared tool: ${String(toolChoice.name)}`);
    return undefined;
  }

  const toolNames = new Set(tools.map(tool => tool.name));

  switch (toolChoice.type) {
  case 'auto':
    return 'auto';
  case 'any':
    return 'required';
  case 'tool': {
    if (!toolChoice.name || !toolNames.has(toolChoice.name)) throw new TranslatorInputError(`Anthropic Messages tool_choice names an undeclared tool: ${String(toolChoice.name)}`);
    return { type: 'function', name: toolChoice.name };
  }
  case 'none':
    return 'none';
  }
};

const translateMetadata = (metadata: AnthropicMessagesMetadataEx): Record<string, string> => Object.fromEntries(Object.entries(metadata).flatMap(([key, value]) => {
  if (key === 'user_id' && value == null) return [];
  if (typeof value !== 'string') throw new TranslatorInputError(`Cannot translate Anthropic Messages metadata field '${key}' to a Responses string metadata value.`);
  return [[key, value]];
}));

export const buildTargetRequest = async (
  payload: AnthropicMessagesPayload,
  codec: SidecarCodec,
): Promise<CanonicalOpenAIResponsesPayload> => {
  // Preserve the source `output_config.effort` value as-is, even if the chosen
  // OpenAI Responses upstream may reject it. Translation stays pairwise and leaves
  // target-side validation to the selected upstream endpoint.
  const effort = resolveReasoningEffort(payload);
  const reasoning = effort !== undefined ? { effort } : undefined;
  const clientTools = filterAnthropicMessagesClientTools(payload.tools);
  const { instructions, prependItems } = placeAnthropicMessagesSystem(payload.system);
  // Anthropic's structured-output schema is already strict. Supply the name
  // required by OpenAI and let OpenAI report any schema constraint it rejects.
  // https://platform.claude.com/docs/en/build-with-claude/structured-outputs
  const format = payload.output_config?.format;
  const jsonSchema = format?.type === 'json_schema'
    ? { name: 'messages_response', strict: true as const, schema: klona(format.schema) }
    : undefined;
  const text = jsonSchema ? { format: { type: 'json_schema' as const, ...jsonSchema } } : undefined;

  // Anthropic `speed: 'fast'` selects OpenAI's priority lane. Without an
  // explicit speed, preserve Anthropic's service tier as an open string.
  // https://docs.claude.com/en/build-with-claude/fast-mode
  // https://platform.openai.com/docs/guides/fast-mode
  const serviceTier = payload.speed === 'fast' ? FAST_SERVICE_TIER : payload.speed === undefined ? payload.service_tier : undefined;
  const toolChoice = translateToolChoice(payload.tool_choice, clientTools);
  const input = [...prependItems];
  let messageIndex = 0;
  for (const turn of partitionAnthropicMessagesTurns(payload.messages)) {
    if (turn.role === 'assistant') {
      const roundTrip = await roundTripAssistantTurn('anthropicMessages', 'openaiResponses', turn.items, codec, findAnthropicMessagesSidecarCarriers, verifyAnthropicMessagesTurnDigest, collectAnthropicMessagesReplayContents);
      input.push(...(roundTrip ? roundTrip.turn : turn.items.flatMap((message, index) => translateAssistantMessage(message, messageIndex + index))));
    } else for (const [index, message] of turn.items.entries()) {
      switch (message.role) {
      case 'user': input.push(...translateUserMessage(message, messageIndex + index)); break;
      case 'system': input.push(...translateAnthropicMessagesSystem(message)); break;
      default: throw new TranslatorInputError(`messages.${messageIndex + index}.role: role '${(message as { role: string }).role}' is not supported on this model`);
      }
    }
    messageIndex += turn.items.length;
  }

  // Keep fallback semantics strict: do not synthesize `temperature: 1`,
  // `store: false`, `parallel_tool_calls: true`, `reasoning.summary`, or
  // `reasoning.context` when the Anthropic Messages source did not express those knobs.
  // The source thinking block carries no reasoning-context mode, so we never
  // invent `all_turns` (or any other value) on the target reasoning object.
  return {
    model: payload.model,
    input,
    ...(instructions !== null ? { instructions } : {}),
    ...(payload.temperature !== undefined ? { temperature: payload.temperature } : {}),
    ...(payload.top_p !== undefined ? { top_p: payload.top_p } : {}),
    max_output_tokens: payload.max_tokens,
    ...(payload.tools !== undefined ? { tools: translateTools(clientTools) } : {}),
    ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
    ...(payload.metadata ? { metadata: translateMetadata(payload.metadata as AnthropicMessagesMetadataEx) } : {}),
    stream: true,
    ...(reasoning ? { reasoning } : {}),
    ...(text ? { text } : {}),
    ...(serviceTier !== undefined ? { service_tier: serviceTier } : {}),
  };
};
