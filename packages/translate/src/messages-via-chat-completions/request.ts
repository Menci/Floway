import { type ChatCompletionsScalarReasoning, chatCompletionsScalarReasoningFromMessagesBlock } from '../shared/chat-completions-and-messages/reasoning.ts';
import { filterMessagesClientTools } from '../shared/messages-via/client-tools.ts';
import { resolveMessagesReasoningEffort } from '../shared/messages-via/reasoning-effort.ts';
import { openAIServiceTierFromMessages } from '../shared/messages-via/service-tier.ts';
import { openAiJsonSchemaCoreFromMessagesFormat } from '../shared/messages-via/structured-output.ts';
import { flattenMessagesToolResult } from '../shared/messages-via/tool-result.ts';
import { normalizeMessagesToolInputSchema } from '../shared/messages-via/tool-schema.ts';
import { TranslatorInputError } from '../translator-input-error.ts';
import type { ChatCompletionsPayload, ChatCompletionsContentPart, ChatCompletionsMessage, ChatCompletionsTool, ChatCompletionsToolCall } from '@floway-dev/protocols/chat-completions';
import type {
  MessagesAssistantContentBlock,
  MessagesAssistantMessage,
  MessagesClientTool,
  MessagesMessage,
  MessagesPayload,
  MessagesServerToolUseBlock,
  MessagesSystemMessage,
  MessagesTextBlock,
  MessagesToolResultBlock,
  MessagesToolUseBlock,
  MessagesUserContentBlock,
  MessagesUserMessage,
} from '@floway-dev/protocols/messages';

const toChatCompletionsContent = (content: string | MessagesUserContentBlock[] | MessagesAssistantContentBlock[]): string | ChatCompletionsContentPart[] | null => {
  if (typeof content === 'string') return content;

  if (!content.some(block => block.type === 'image')) {
    return content
      .filter((block): block is MessagesTextBlock => block.type === 'text')
      .map(block => block.text)
      .join('\n\n');
  }

  const parts: ChatCompletionsContentPart[] = [];

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

const toChatCompletionsFunctionCall = (block: MessagesToolUseBlock | MessagesServerToolUseBlock): ChatCompletionsToolCall => ({
  id: block.id,
  type: 'function',
  function: {
    name: block.name,
    arguments: JSON.stringify(block.input),
  },
});

type PendingAssistantMessage = {
  textParts: string[];
  toolCalls: ChatCompletionsToolCall[];
  scalarReasoning: ChatCompletionsScalarReasoning | null;
};

const recordPendingScalarReasoning = (pending: PendingAssistantMessage, block: MessagesAssistantContentBlock): void => {
  // Chat scalar reasoning cannot represent ordered interleaved Messages
  // thinking blocks. Project only the first source-order group so readable text
  // is never paired with an opaque signature from a later block.
  pending.scalarReasoning ??= chatCompletionsScalarReasoningFromMessagesBlock(block);
};

const flushPendingAssistantMessage = (messages: ChatCompletionsMessage[], pending: PendingAssistantMessage): void => {
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

const translateMessagesUser = (message: MessagesUserMessage, messageIdx: number): ChatCompletionsMessage[] => {
  if (!Array.isArray(message.content)) {
    return [
      {
        role: 'user',
        content: toChatCompletionsContent(message.content),
      },
    ];
  }

  const messages: ChatCompletionsMessage[] = [];
  const pendingUserBlocks: Exclude<MessagesUserContentBlock, MessagesToolResultBlock>[] = [];

  const flushPendingUserBlocks = () => {
    if (pendingUserBlocks.length === 0) return;
    messages.push({
      role: 'user',
      content: toChatCompletionsContent(pendingUserBlocks),
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
        content: flattenMessagesToolResult(block.content),
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

const translateMessagesAssistant = (message: MessagesAssistantMessage, messageIdx: number): ChatCompletionsMessage[] => {
  if (!Array.isArray(message.content)) {
    return [
      {
        role: 'assistant',
        content: toChatCompletionsContent(message.content),
      },
    ];
  }

  const messages: ChatCompletionsMessage[] = [];
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
      pending.toolCalls.push(toChatCompletionsFunctionCall(block));
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
// as a separate Chat Completions text part so a CC→Messages→CC round trip
// does not silently merge them. Falls back to the simple string form when
// the source is already a single-string field.
const systemContentFromBlocks = (system: string | MessagesTextBlock[]): string | ChatCompletionsContentPart[] =>
  typeof system === 'string'
    ? system
    : system.map(block => ({ type: 'text', text: block.text }));

const translateMessagesSystem = (message: MessagesSystemMessage): ChatCompletionsMessage[] => [
  {
    role: 'system',
    content: systemContentFromBlocks(message.content),
  },
];

const translateMessagesInput = (messages: MessagesMessage[], system: string | MessagesTextBlock[] | undefined): ChatCompletionsMessage[] => {
  const isEmptySystem = system == null || (typeof system === 'string' ? system === '' : system.length === 0);
  const systemMessages: ChatCompletionsMessage[] = isEmptySystem
    ? []
    : [
        {
          role: 'system',
          content: systemContentFromBlocks(system),
        },
      ];

  return [
    ...systemMessages,
    ...messages.flatMap((message, messageIdx): ChatCompletionsMessage[] => {
      switch (message.role) {
      case 'user': return translateMessagesUser(message, messageIdx);
      case 'assistant': return translateMessagesAssistant(message, messageIdx);
      case 'system': return translateMessagesSystem(message);
      default: throw new TranslatorInputError(`messages.${messageIdx}.role: role '${(message as { role: string }).role}' is not supported on this model`);
      }
    }),
  ];
};

const translateMessagesTools = (tools?: MessagesClientTool[]): ChatCompletionsTool[] | undefined =>
  // Do not hide target-side function-name constraints by renaming tools here;
  // the Messages source contract has no reverse mapping surface for that.
  tools?.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: normalizeMessagesToolInputSchema(tool.input_schema),
      ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
    },
  }));

const translateMessagesToolChoice = (toolChoice?: MessagesPayload['tool_choice'], tools?: MessagesClientTool[]): ChatCompletionsPayload['tool_choice'] => {
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

export const buildTargetRequest = (payload: MessagesPayload): ChatCompletionsPayload => {
  const clientTools = filterMessagesClientTools(payload.tools);
  // Pass effort through verbatim; per-upstream enum acceptance (e.g. some
  // backends rejecting `xhigh`/`max`) is the target interceptor's concern.
  const reasoningEffort = resolveMessagesReasoningEffort(payload);
  const jsonSchema = openAiJsonSchemaCoreFromMessagesFormat(payload.output_config?.format);
  const responseFormat = jsonSchema ? { type: 'json_schema' as const, json_schema: jsonSchema } : undefined;

  const serviceTier = openAIServiceTierFromMessages(payload);

  return {
    model: payload.model,
    messages: translateMessagesInput(payload.messages, payload.system),
    ...(reasoningEffort !== undefined ? { reasoning_effort: reasoningEffort } : {}),
    max_tokens: payload.max_tokens,
    stop: payload.stop_sequences,
    stream: true,
    temperature: payload.temperature,
    top_p: payload.top_p,
    tools: translateMessagesTools(clientTools),
    tool_choice: translateMessagesToolChoice(payload.tool_choice, clientTools),
    ...(responseFormat ? { response_format: responseFormat } : {}),
    ...(serviceTier !== undefined ? { service_tier: serviceTier } : {}),
  };
};
