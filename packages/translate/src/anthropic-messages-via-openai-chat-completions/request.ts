import { type OpenAIChatCompletionsScalarReasoning, openaiChatCompletionsScalarReasoningFromAnthropicMessagesBlock } from '../shared/openai-chat-completions-and-anthropic-messages/reasoning.ts';
import { filterAnthropicMessagesClientTools } from '../shared/anthropic-messages-via/client-tools.ts';
import { resolveAnthropicMessagesReasoningEffort } from '../shared/anthropic-messages-via/reasoning-effort.ts';
import { openAIServiceTierFromAnthropicMessages } from '../shared/anthropic-messages-via/service-tier.ts';
import { openAiJsonSchemaCoreFromAnthropicMessagesFormat } from '../shared/anthropic-messages-via/structured-output.ts';
import { flattenAnthropicMessagesToolResult } from '../shared/anthropic-messages-via/tool-result.ts';
import { normalizeAnthropicMessagesToolInputSchema } from '../shared/anthropic-messages-via/tool-schema.ts';
import { TranslatorInputError } from '../translator-input-error.ts';
import type { OpenAIChatCompletionsPayload, OpenAIChatCompletionsContentPart, OpenAIChatCompletionsMessage, OpenAIChatCompletionsTool, OpenAIChatCompletionsToolCall } from '@floway-dev/protocols/openai-chat-completions';
import type {
  AnthropicMessagesAssistantContentBlock,
  AnthropicMessagesAssistantMessage,
  AnthropicMessagesClientTool,
  AnthropicMessagesMessage,
  AnthropicMessagesPayload,
  AnthropicMessagesServerToolUseBlock,
  AnthropicMessagesSystemMessage,
  AnthropicMessagesTextBlock,
  AnthropicMessagesToolResultBlock,
  AnthropicMessagesToolUseBlock,
  AnthropicMessagesUserContentBlock,
  AnthropicMessagesUserMessage,
} from '@floway-dev/protocols/anthropic-messages';

const toOpenAIChatCompletionsContent = (content: string | AnthropicMessagesUserContentBlock[] | AnthropicMessagesAssistantContentBlock[]): string | OpenAIChatCompletionsContentPart[] | null => {
  if (typeof content === 'string') return content;

  if (!content.some(block => block.type === 'image')) {
    return content
      .filter((block): block is AnthropicMessagesTextBlock => block.type === 'text')
      .map(block => block.text)
      .join('\n\n');
  }

  const parts: OpenAIChatCompletionsContentPart[] = [];

  for (const block of content) {
    if (block.type === 'text') {
      parts.push({ type: 'text', text: block.text });
      continue;
    }

    if (block.type === 'image') {
      parts.push({
        type: 'image_url',
        image_url: {
          url: `data:${block.source.media_type};base64,${block.source.data}`,
        },
      });
    }
  }

  return parts;
};

const toOpenAIChatCompletionsFunctionCall = (block: AnthropicMessagesToolUseBlock | AnthropicMessagesServerToolUseBlock): OpenAIChatCompletionsToolCall => ({
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
  scalarReasoning: OpenAIChatCompletionsScalarReasoning | null;
};

const recordPendingScalarReasoning = (pending: PendingAssistantMessage, block: AnthropicMessagesAssistantContentBlock): void => {
  // Chat scalar reasoning cannot represent ordered interleaved Anthropic Messages
  // thinking blocks. Project only the first source-order group so readable text
  // is never paired with an opaque signature from a later block.
  pending.scalarReasoning ??= openaiChatCompletionsScalarReasoningFromAnthropicMessagesBlock(block);
};

const flushPendingAssistantMessage = (messages: OpenAIChatCompletionsMessage[], pending: PendingAssistantMessage): void => {
  if (pending.textParts.length === 0 && pending.toolCalls.length === 0 && !pending.scalarReasoning) {
    return;
  }

  const reasoning = pending.scalarReasoning;

  messages.push({
    role: 'assistant',
    content: pending.textParts.join('\n\n') || null,
    ...(pending.toolCalls.length > 0 ? { tool_calls: [...pending.toolCalls] } : {}),
    ...(reasoning
      ? {
          reasoning_text: reasoning.reasoningText,
          reasoning_opaque: reasoning.reasoningOpaque,
        }
      : {}),
  });

  pending.textParts.length = 0;
  pending.toolCalls.length = 0;
  pending.scalarReasoning = null;
};

const translateAnthropicMessagesUser = (message: AnthropicMessagesUserMessage, messageIdx: number): OpenAIChatCompletionsMessage[] => {
  if (!Array.isArray(message.content)) {
    return [
      {
        role: 'user',
        content: toOpenAIChatCompletionsContent(message.content),
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
      // Preserving source chronology matters more than keeping one Chat message,
      // so interleaved user content and tool results become alternating messages.
      flushPendingUserBlocks();
      messages.push({
        role: 'tool',
        tool_call_id: block.tool_use_id,
        content: flattenAnthropicMessagesToolResult(block.content),
      });
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
        content: toOpenAIChatCompletionsContent(message.content),
      },
    ];
  }

  const messages: OpenAIChatCompletionsMessage[] = [];
  const pending: PendingAssistantMessage = {
    textParts: [],
    toolCalls: [],
    scalarReasoning: null,
  };

  for (const [blockIdx, block] of message.content.entries()) {
    switch (block.type) {
    case 'text':
      pending.textParts.push(block.text);
      break;
    case 'thinking':
    case 'redacted_thinking':
      recordPendingScalarReasoning(pending, block);
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
const systemContentFromBlocks = (system: string | AnthropicMessagesTextBlock[]): string | OpenAIChatCompletionsContentPart[] =>
  typeof system === 'string'
    ? system
    : system.map(block => ({ type: 'text', text: block.text }));

const translateAnthropicMessagesSystem = (message: AnthropicMessagesSystemMessage): OpenAIChatCompletionsMessage[] => [
  {
    role: 'system',
    content: systemContentFromBlocks(message.content),
  },
];

const translateAnthropicMessagesInput = (messages: AnthropicMessagesMessage[], system: string | AnthropicMessagesTextBlock[] | undefined): OpenAIChatCompletionsMessage[] => {
  const isEmptySystem = system == null || (typeof system === 'string' ? system === '' : system.length === 0);
  const systemMessages: OpenAIChatCompletionsMessage[] = isEmptySystem
    ? []
    : [
        {
          role: 'system',
          content: systemContentFromBlocks(system),
        },
      ];

  return [
    ...systemMessages,
    ...messages.flatMap((message, messageIdx): OpenAIChatCompletionsMessage[] => {
      switch (message.role) {
      case 'user': return translateAnthropicMessagesUser(message, messageIdx);
      case 'assistant': return translateAnthropicMessagesAssistant(message, messageIdx);
      case 'system': return translateAnthropicMessagesSystem(message);
      default: throw new TranslatorInputError(`messages.${messageIdx}.role: role '${(message as { role: string }).role}' is not supported on this model`);
      }
    }),
  ];
};

const translateAnthropicMessagesTools = (tools?: AnthropicMessagesClientTool[]): OpenAIChatCompletionsTool[] | undefined =>
  // Do not hide target-side function-name constraints by renaming tools here;
  // the Anthropic Messages source contract has no reverse mapping surface for that.
  tools?.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: normalizeAnthropicMessagesToolInputSchema(tool.input_schema),
      ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
    },
  }));

const translateAnthropicMessagesToolChoice = (toolChoice?: AnthropicMessagesPayload['tool_choice'], tools?: AnthropicMessagesClientTool[]): OpenAIChatCompletionsPayload['tool_choice'] => {
  if (!toolChoice || !tools || tools.length === 0) return undefined;

  switch (toolChoice.type) {
  case 'auto':
    return 'auto';
  case 'any':
    return 'required';
  case 'tool':
    return toolChoice.name && tools.some(tool => tool.name === toolChoice.name) ? { type: 'function', function: { name: toolChoice.name } } : undefined;
  case 'none':
    return 'none';
  }
};

export const buildTargetRequest = (payload: AnthropicMessagesPayload): OpenAIChatCompletionsPayload => {
  const clientTools = filterAnthropicMessagesClientTools(payload.tools);
  // Pass effort through verbatim; per-upstream enum acceptance (e.g. some
  // backends rejecting `xhigh`/`max`) is the target interceptor's concern.
  const reasoningEffort = resolveAnthropicMessagesReasoningEffort(payload);
  const jsonSchema = openAiJsonSchemaCoreFromAnthropicMessagesFormat(payload.output_config?.format);
  const responseFormat = jsonSchema ? { type: 'json_schema' as const, json_schema: jsonSchema } : undefined;

  const serviceTier = openAIServiceTierFromAnthropicMessages(payload);

  return {
    model: payload.model,
    messages: translateAnthropicMessagesInput(payload.messages, payload.system),
    ...(reasoningEffort !== undefined ? { reasoning_effort: reasoningEffort } : {}),
    max_tokens: payload.max_tokens,
    stop: payload.stop_sequences,
    stream: true,
    temperature: payload.temperature,
    top_p: payload.top_p,
    tools: translateAnthropicMessagesTools(clientTools),
    tool_choice: translateAnthropicMessagesToolChoice(payload.tool_choice, clientTools),
    ...(responseFormat ? { response_format: responseFormat } : {}),
    ...(serviceTier !== undefined ? { service_tier: serviceTier } : {}),
  };
};
