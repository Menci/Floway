import { type ChatScalarReasoning, chatScalarReasoningFromMessagesBlock } from '../shared/chat-and-messages/reasoning.ts';
import { openAiJsonSchemaCoreFromMessagesFormat } from '../shared/messages/structured-output.ts';
import { normalizeMessagesToolInputSchema } from '../shared/messages-via/tool-schema.ts';
import type { ChatCompletionsPayload, ContentPart, Message, Tool, ToolCall } from '@floway-dev/protocols/chat-completions';
import type {
  MessagesAssistantContentBlock,
  MessagesAssistantMessage,
  MessagesClientTool,
  MessagesMessage,
  MessagesPayload,
  MessagesServerToolUseBlock,
  MessagesTextBlock,
  MessagesToolResultBlock,
  MessagesToolUseBlock,
  MessagesUserContentBlock,
  MessagesUserMessage,
} from '@floway-dev/protocols/messages';

const toChatCompletionsContent = (content: string | MessagesUserContentBlock[] | MessagesAssistantContentBlock[]): string | ContentPart[] | null => {
  if (typeof content === 'string') return content;

  if (!content.some(block => block.type === 'image')) {
    return content
      .filter((block): block is MessagesTextBlock => block.type === 'text')
      .map(block => block.text)
      .join('\n\n');
  }

  const parts: ContentPart[] = [];

  for (const block of content) {
    if (block.type === 'text') {
      parts.push({ type: 'text', text: block.text });
      continue;
    }

    if (block.type !== 'image') continue;

    parts.push({
      type: 'image_url',
      image_url: {
        url: `data:${block.source.media_type};base64,${block.source.data}`,
      },
    });
  }

  return parts;
};

const toChatCompletionsToolResultContent = (content: MessagesToolResultBlock['content']): string => {
  if (typeof content === 'string') {
    return content;
  }

  const textBlocks = content.filter((block): block is MessagesTextBlock => block.type === 'text');
  if (textBlocks.length === content.length) {
    return textBlocks.map(block => block.text).join('\n\n');
  }

  return JSON.stringify(content);
};

const toChatCompletionsFunctionCall = (block: MessagesToolUseBlock | MessagesServerToolUseBlock): ToolCall => ({
  id: block.id,
  type: 'function',
  function: {
    name: block.name,
    arguments: JSON.stringify(block.input),
  },
});

type PendingAssistantMessage = {
  textParts: string[];
  toolCalls: ToolCall[];
  scalarReasoning: ChatScalarReasoning | null;
};

const recordPendingScalarReasoning = (pending: PendingAssistantMessage, block: MessagesAssistantContentBlock): void => {
  // Chat scalar reasoning cannot represent ordered interleaved Messages
  // thinking blocks. Project only the first source-order group so readable text
  // is never paired with an opaque signature from a later block.
  pending.scalarReasoning ??= chatScalarReasoningFromMessagesBlock(block);
};

const flushPendingAssistantMessage = (messages: Message[], pending: PendingAssistantMessage): void => {
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
          reasoning_opaque: reasoning.hasReasoningOpaque ? reasoning.reasoningOpaque : null,
        }
      : {}),
  });

  pending.textParts.length = 0;
  pending.toolCalls.length = 0;
  pending.scalarReasoning = null;
};

const getClientTools = (tools?: MessagesPayload['tools']): MessagesClientTool[] | undefined => {
  const clientTools = tools?.filter((tool): tool is MessagesClientTool => tool.type === undefined || tool.type === 'custom');
  return clientTools?.length ? clientTools : undefined;
};

const translateMessagesUser = (message: MessagesUserMessage): Message[] => {
  if (!Array.isArray(message.content)) {
    return [
      {
        role: 'user',
        content: toChatCompletionsContent(message.content),
      },
    ];
  }

  const messages: Message[] = [];
  const pendingUserBlocks: Exclude<MessagesUserContentBlock, MessagesToolResultBlock>[] = [];

  const flushPendingUserBlocks = () => {
    if (pendingUserBlocks.length === 0) return;
    messages.push({
      role: 'user',
      content: toChatCompletionsContent(pendingUserBlocks),
    });

    pendingUserBlocks.length = 0;
  };

  for (const block of message.content) {
    if (block.type !== 'tool_result') {
      pendingUserBlocks.push(block);
      continue;
    }

    // Preserving source chronology matters more than keeping one Chat message,
    // so interleaved user content and tool results become alternating messages.
    flushPendingUserBlocks();
    messages.push({
      role: 'tool',
      tool_call_id: block.tool_use_id,
      content: toChatCompletionsToolResultContent(block.content),
    });
  }

  flushPendingUserBlocks();

  return messages;
};

const translateMessagesAssistant = (message: MessagesAssistantMessage): Message[] => {
  if (!Array.isArray(message.content)) {
    return [
      {
        role: 'assistant',
        content: toChatCompletionsContent(message.content),
      },
    ];
  }

  const messages: Message[] = [];
  const pending: PendingAssistantMessage = {
    textParts: [],
    toolCalls: [],
    scalarReasoning: null,
  };

  for (const block of message.content) {
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
    }
  }

  flushPendingAssistantMessage(messages, pending);
  return messages;
};

const translateMessagesInput = (messages: MessagesMessage[], system: string | MessagesTextBlock[] | undefined): Message[] => {
  // Messages system blocks are prompt boundaries; keep them as separated
  // paragraphs when falling back to Chat Completions.
  const systemMessages: Message[] = system
    ? [
        {
          role: 'system',
          content: typeof system === 'string' ? system : system.map(block => block.text).join('\n\n'),
        },
      ]
    : [];

  return [...systemMessages, ...messages.flatMap(message => (message.role === 'user' ? translateMessagesUser(message) : translateMessagesAssistant(message)))];
};

const translateMessagesTools = (tools?: MessagesClientTool[]): Tool[] | undefined =>
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

export const translateMessagesToChatCompletions = (payload: MessagesPayload): ChatCompletionsPayload => {
  const clientTools = getClientTools(payload.tools);
  // Pass effort through verbatim; per-upstream enum acceptance (e.g. some
  // backends rejecting `xhigh`/`max`) is the target interceptor's concern.
  let reasoningEffort: string | undefined;
  if (payload.output_config?.effort) {
    reasoningEffort = payload.output_config.effort;
  } else if (payload.thinking?.type === 'disabled') {
    reasoningEffort = 'none';
  }
  const jsonSchema = openAiJsonSchemaCoreFromMessagesFormat(payload.output_config?.format);
  const responseFormat = jsonSchema ? { type: 'json_schema' as const, json_schema: jsonSchema } : undefined;

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
  };
};

export const buildTargetRequest = translateMessagesToChatCompletions;
