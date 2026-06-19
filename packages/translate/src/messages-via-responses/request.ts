import { openAiJsonSchemaCoreFromMessagesFormat } from '../shared/messages/structured-output.ts';
import { messagesReasoningBlockToResponsesReasoning } from '../shared/messages-and-responses/reasoning.ts';
import { resolveMessagesReasoningEffort } from '../shared/messages-via/reasoning-effort.ts';
import { normalizeMessagesToolInputSchema } from '../shared/messages-via/tool-schema.ts';
import {
  type MessagesAssistantMessage,
  type MessagesClientTool,
  type MessagesMessage,
  type MessagesPayload,
  type MessagesServerToolUseBlock,
  type MessagesSystemMessage,
  type MessagesTextBlock,
  type MessagesToolResultBlock,
  type MessagesToolUseBlock,
  type MessagesUserContentBlock,
  type MessagesUserMessage,
  type MessagesWebSearchToolResultBlock,
} from '@floway-dev/protocols/messages';
import type { ResponsesInputContent, ResponsesInputItem, ResponsesPayload, ResponsesTool, ResponsesToolChoice } from '@floway-dev/protocols/responses';

const flushPendingContent = (pending: ResponsesInputContent[], input: ResponsesInputItem[], role: 'user' | 'assistant'): void => {
  if (pending.length === 0) return;
  input.push({ type: 'message', role, content: [...pending] });
  pending.length = 0;
};

const translateUserContentBlock = (block: Exclude<MessagesUserContentBlock, MessagesToolResultBlock>): ResponsesInputContent => {
  if (block.type === 'text') return { type: 'input_text', text: block.text };
  if (block.type === 'image') {
    return {
      type: 'input_image',
      image_url: `data:${block.source.media_type};base64,${block.source.data}`,
      detail: 'auto',
    };
  }

  throw new Error(`Messages → Responses translator does not accept ${(block as { type: string }).type} user content blocks.`);
};

const toResponsesToolResultOutput = (content: MessagesToolResultBlock['content']): string => {
  if (typeof content === 'string') {
    return content;
  }

  const textBlocks = content.filter((block): block is MessagesTextBlock => block.type === 'text');
  if (textBlocks.length === content.length) {
    return textBlocks.map(block => block.text).join('\n\n');
  }

  return JSON.stringify(content);
};

const toResponsesFunctionCall = (block: MessagesToolUseBlock | MessagesServerToolUseBlock): ResponsesInputItem => ({
  type: 'function_call',
  call_id: block.id,
  name: block.name,
  arguments: JSON.stringify(block.input),
  status: 'completed',
});

const toResponsesStructuredToolOutput = (block: MessagesWebSearchToolResultBlock): Extract<ResponsesInputItem, { type: 'function_call_output' }> => ({
  type: 'function_call_output',
  call_id: block.tool_use_id,
  output: JSON.stringify(block.content),
  status: Array.isArray(block.content) ? 'completed' : 'incomplete',
});

const getClientTools = (tools?: MessagesPayload['tools']): MessagesClientTool[] | undefined => {
  if (!tools || tools.length === 0) return undefined;

  const clientTools = tools.filter((tool): tool is MessagesClientTool => tool.type === undefined || tool.type === 'custom');
  return clientTools.length > 0 ? clientTools : undefined;
};

const translateUserMessage = (message: MessagesUserMessage): ResponsesInputItem[] => {
  if (typeof message.content === 'string') {
    return [{ type: 'message', role: 'user', content: message.content }];
  }

  const input: ResponsesInputItem[] = [];
  const pendingContent: ResponsesInputContent[] = [];

  for (const block of message.content) {
    if (block.type === 'tool_result') {
      // Responses can represent alternating user content and tool outputs, so
      // preserve Messages block chronology instead of moving all tool results to
      // the front of the turn.
      flushPendingContent(pendingContent, input, 'user');
      input.push({
        type: 'function_call_output',
        call_id: block.tool_use_id,
        output: toResponsesToolResultOutput(block.content),
        status: block.is_error ? 'incomplete' : 'completed',
      });
      continue;
    }

    pendingContent.push(translateUserContentBlock(block));
  }

  flushPendingContent(pendingContent, input, 'user');
  return input;
};

const translateAssistantMessage = (message: MessagesAssistantMessage): ResponsesInputItem[] => {
  if (typeof message.content === 'string') {
    return [{ type: 'message', role: 'assistant', content: message.content }];
  }

  const input: ResponsesInputItem[] = [];
  const pendingContent: ResponsesInputContent[] = [];

  for (const block of message.content) {
    if (block.type === 'tool_use' || block.type === 'server_tool_use') {
      flushPendingContent(pendingContent, input, 'assistant');
      input.push(toResponsesFunctionCall(block));
      continue;
    }

    if (block.type === 'web_search_tool_result') {
      flushPendingContent(pendingContent, input, 'assistant');
      input.push(toResponsesStructuredToolOutput(block));
      continue;
    }

    if (block.type === 'thinking' || block.type === 'redacted_thinking') {
      flushPendingContent(pendingContent, input, 'assistant');
      input.push(messagesReasoningBlockToResponsesReasoning(block, input.length));
      continue;
    }

    if (block.type === 'text') {
      pendingContent.push({ type: 'output_text', text: block.text });
      continue;
    }

    throw new Error(`Messages → Responses translator does not accept ${(block as { type: string }).type} assistant content blocks.`);
  }

  flushPendingContent(pendingContent, input, 'assistant');
  return input;
};

const translateMessagesSystem = (message: MessagesSystemMessage): ResponsesInputItem[] => [
  {
    type: 'message',
    role: 'system',
    content: typeof message.content === 'string' ? message.content : message.content.map(block => block.text).join('\n\n'),
  },
];

const translateMessagesInput = (messages: MessagesMessage[]): ResponsesInputItem[] =>
  messages.flatMap((message): ResponsesInputItem[] => {
    switch (message.role) {
    case 'user': return translateUserMessage(message);
    case 'assistant': return translateAssistantMessage(message);
    case 'system': return translateMessagesSystem(message);
    default: throw new Error(`Messages → Responses translator does not accept role ${(message as { role: string }).role}.`);
    }
  });

const translateSystemPrompt = (system: string | MessagesTextBlock[] | undefined): string | null => {
  if (typeof system === 'string') return system;
  if (!system) return null;

  // Messages system blocks are prompt boundaries. Keep paragraph separation on
  // OpenAI fallbacks instead of collapsing headings or lists with spaces.
  const text = system.map(block => block.text).join('\n\n');
  return text.length > 0 ? text : null;
};

const translateTools = (tools: MessagesClientTool[] | undefined): ResponsesTool[] | null => {
  if (!tools || tools.length === 0) return null;

  return tools.map(tool => ({
    type: 'function',
    name: tool.name,
    parameters: normalizeMessagesToolInputSchema(tool.input_schema),
    // Responses tools default stricter than Anthropic/Chat-style function tools,
    // so omitted source strictness is made explicit as false.
    strict: tool.strict ?? false,
    ...(tool.description ? { description: tool.description } : {}),
  }));
};

const translateToolChoice = (toolChoice: MessagesPayload['tool_choice'], tools?: MessagesClientTool[]): ResponsesToolChoice => {
  if (!toolChoice || !tools || tools.length === 0) return 'auto';

  const toolNames = new Set(tools.map(tool => tool.name));

  switch (toolChoice.type) {
  case 'auto':
    return 'auto';
  case 'any':
    return 'required';
  case 'tool':
    return toolChoice.name && toolNames.has(toolChoice.name) ? { type: 'function', name: toolChoice.name } : 'auto';
  case 'none':
    return 'none';
  default:
    return 'auto';
  }
};

export const translateMessagesToResponses = (payload: MessagesPayload): ResponsesPayload => {
  // Preserve the source `output_config.effort` value as-is, even if the chosen
  // Responses upstream may reject it. Translation stays pairwise and leaves
  // target-side validation to the selected upstream endpoint.
  const effort = resolveMessagesReasoningEffort(payload);
  const reasoning = effort ? { effort } : undefined;
  const clientTools = getClientTools(payload.tools);
  const instructions = translateSystemPrompt(payload.system);
  const jsonSchema = openAiJsonSchemaCoreFromMessagesFormat(payload.output_config?.format);
  const text = jsonSchema ? { format: { type: 'json_schema' as const, ...jsonSchema } } : undefined;

  // Keep fallback semantics strict: do not synthesize `temperature: 1`,
  // `store: false`, `parallel_tool_calls: true`, or `reasoning.summary` when the
  // Messages source did not express those knobs.
  return {
    model: payload.model,
    input: translateMessagesInput(payload.messages),
    ...(instructions !== null ? { instructions } : {}),
    ...(payload.temperature !== undefined ? { temperature: payload.temperature } : {}),
    ...(payload.top_p !== undefined ? { top_p: payload.top_p } : {}),
    max_output_tokens: payload.max_tokens,
    ...(payload.tools !== undefined ? { tools: translateTools(clientTools) } : {}),
    tool_choice: translateToolChoice(payload.tool_choice, clientTools),
    ...(payload.metadata ? { metadata: { ...payload.metadata } } : {}),
    stream: true,
    ...(reasoning ? { reasoning } : {}),
    ...(text ? { text } : {}),
  };
};

export { translateMessagesToResponses as buildTargetRequest };
