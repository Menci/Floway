import { openAiJsonSchemaCoreFromMessagesFormat } from '../shared/messages/structured-output.ts';
import { messagesReasoningBlockToResponsesReasoning } from '../shared/messages-and-responses/reasoning.ts';
import { normalizeMessagesToolInputSchema } from '../shared/messages-via/tool-schema.ts';
import {
  type MessagesAssistantMessage,
  type MessagesClientTool,
  type MessagesMessage,
  type MessagesPayload,
  type MessagesServerToolUseBlock,
  type MessagesTextBlock,
  type MessagesToolResultBlock,
  type MessagesToolUseBlock,
  type MessagesUserContentBlock,
  type MessagesUserMessage,
  type MessagesWebSearchToolResultBlock,
} from '@floway-dev/protocols/messages';
import type { ResponseInputContent, ResponseInputItem, ResponsesPayload, ResponseTool, ResponseToolChoice } from '@floway-dev/protocols/responses';

const flushPendingContent = (pending: ResponseInputContent[], input: ResponseInputItem[], role: 'user' | 'assistant'): void => {
  if (pending.length === 0) return;
  input.push({ type: 'message', role, content: [...pending] });
  pending.length = 0;
};

const translateUserContentBlock = (block: MessagesUserContentBlock): ResponseInputContent | undefined => {
  if (block.type === 'text') return { type: 'input_text', text: block.text };
  if (block.type !== 'image') return undefined;

  return {
    type: 'input_image',
    image_url: `data:${block.source.media_type};base64,${block.source.data}`,
    detail: 'auto',
  };
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

const toResponsesFunctionCall = (block: MessagesToolUseBlock | MessagesServerToolUseBlock): ResponseInputItem => ({
  type: 'function_call',
  call_id: block.id,
  name: block.name,
  arguments: JSON.stringify(block.input),
  status: 'completed',
});

const toResponsesStructuredToolOutput = (block: MessagesWebSearchToolResultBlock): Extract<ResponseInputItem, { type: 'function_call_output' }> => ({
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

const translateUserMessage = (message: MessagesUserMessage): ResponseInputItem[] => {
  if (typeof message.content === 'string') {
    return [{ type: 'message', role: 'user', content: message.content }];
  }

  const input: ResponseInputItem[] = [];
  const pendingContent: ResponseInputContent[] = [];

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

    const content = translateUserContentBlock(block);
    if (content) pendingContent.push(content);
  }

  flushPendingContent(pendingContent, input, 'user');
  return input;
};

const translateAssistantMessage = (message: MessagesAssistantMessage): ResponseInputItem[] => {
  if (typeof message.content === 'string') {
    return [{ type: 'message', role: 'assistant', content: message.content }];
  }

  const input: ResponseInputItem[] = [];
  const pendingContent: ResponseInputContent[] = [];

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
      const reasoning = messagesReasoningBlockToResponsesReasoning(block, input.length);
      if (reasoning) input.push(reasoning);
      continue;
    }

    if (block.type === 'text') {
      pendingContent.push({ type: 'output_text', text: block.text });
    }
  }

  flushPendingContent(pendingContent, input, 'assistant');
  return input;
};

const translateMessagesInput = (messages: MessagesMessage[]): ResponseInputItem[] =>
  messages.flatMap(message => (message.role === 'user' ? translateUserMessage(message) : translateAssistantMessage(message)));

const translateSystemPrompt = (system: string | MessagesTextBlock[] | undefined): string | null => {
  if (typeof system === 'string') return system;
  if (!system) return null;

  // Messages system blocks are prompt boundaries. Keep paragraph separation on
  // OpenAI fallbacks instead of collapsing headings or lists with spaces.
  const text = system.map(block => block.text).join('\n\n');
  return text.length > 0 ? text : null;
};

const translateTools = (tools: MessagesClientTool[] | undefined): ResponseTool[] | null => {
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

const translateToolChoice = (toolChoice: MessagesPayload['tool_choice'], tools?: MessagesClientTool[]): ResponseToolChoice => {
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

const translateMessagesReasoningEffort = (payload: MessagesPayload): string | undefined => {
  if (payload.output_config?.effort) return payload.output_config.effort;
  if (payload.thinking?.type === 'disabled') return 'none';
  return undefined;
};

export const translateMessagesToResponses = (payload: MessagesPayload): ResponsesPayload => {
  // Preserve the source `output_config.effort` value as-is, even if the chosen
  // Responses upstream may reject it. Translation stays pairwise and leaves
  // target-side validation to the selected upstream endpoint.
  const effort = translateMessagesReasoningEffort(payload);
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
