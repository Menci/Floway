import { parseToolArgumentsObject } from '../shared/messages/tool-arguments.ts';
import { responsesReasoningToMessagesBlock } from '../shared/messages-and-responses/reasoning.ts';
import { buildCustomToolInputSchema } from '../shared/responses-via/custom-tool-wrap.ts';
import { fetchRemoteImage, type RemoteImageLoader, resolveImageUrlToMessagesImage } from '../shared/via-messages/remote-images.ts';
import {
  MESSAGES_FALLBACK_MAX_TOKENS,
  type MessagesAssistantContentBlock,
  type MessagesAssistantMessage,
  type MessagesMessage,
  type MessagesPayload,
  type MessagesTool,
  type MessagesToolResultBlock,
  type MessagesUserContentBlock,
  type MessagesUserMessage,
} from '@floway-dev/protocols/messages';
import type {
  ResponseInputImage,
  ResponseInputItem,
  ResponseInputMessage,
  ResponseInputText,
  ResponsesPayload,
  ResponseTool,
  ResponseToolChoice,
} from '@floway-dev/protocols/responses';

interface TranslateResponsesToMessagesOptions {
  loadRemoteImage?: RemoteImageLoader;
  /**
   * Preferred cap used when the source payload omits `max_output_tokens`.
   * Callers in the data plane forward the model's advertised `/models` output
   * cap so the translated Messages request reflects the upstream-known limit
   * rather than being silently capped by a target-side default later.
   */
  fallbackMaxOutputTokens?: number;
}

/**
 * Names of Responses `custom` tools the request translator wrapped as
 * single-string function tools. Returned alongside the translated payload so
 * the trip's events translator can project wrapped function calls back into
 * `custom_tool_call` outputs.
 */
export interface ResponsesToMessagesResult {
  target: MessagesPayload;
  customToolNames: Set<string>;
}

const extractSystemText = (message: ResponseInputMessage): string => {
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';

  // Assumption: OpenAI text parts are transport fragments of one message, not
  // paragraph-level blocks. Keep the existing no-separator join until we have
  // stronger evidence that Responses text parts carry harder boundaries.
  return message.content.map(block => ('text' in block ? block.text : '')).join('');
};

const translateUserMessage = async (message: ResponseInputMessage, loadRemoteImage: RemoteImageLoader): Promise<MessagesUserMessage> => {
  if (typeof message.content === 'string') {
    return { role: 'user', content: message.content };
  }

  const content: MessagesUserContentBlock[] = [];

  for (const block of message.content) {
    if (block.type === 'input_text') {
      content.push({ type: 'text', text: (block as ResponseInputText).text });
      continue;
    }

    if (block.type !== 'input_image') continue;

    const image = await resolveImageUrlToMessagesImage((block as ResponseInputImage).image_url, loadRemoteImage);
    if (image) content.push(image);
  }

  return { role: 'user', content: content.length > 0 ? content : '' };
};

const translateAssistantMessage = (message: ResponseInputMessage): MessagesAssistantMessage => {
  if (typeof message.content === 'string') {
    return { role: 'assistant', content: message.content };
  }

  const content: MessagesAssistantContentBlock[] = [];

  for (const block of message.content) {
    if (block.type === 'output_text') {
      content.push({ type: 'text', text: (block as ResponseInputText).text });
    }
  }

  return { role: 'assistant', content: content.length > 0 ? content : '' };
};

const appendAssistantBlock = (messages: MessagesMessage[], block: MessagesAssistantContentBlock): void => {
  const lastMessage = messages[messages.length - 1];

  if (lastMessage?.role === 'assistant' && Array.isArray(lastMessage.content)) {
    lastMessage.content.push(block);
    return;
  }

  messages.push({ role: 'assistant', content: [block] });
};

const appendUserBlock = (messages: MessagesMessage[], block: MessagesToolResultBlock): void => {
  const lastMessage = messages[messages.length - 1];

  if (lastMessage?.role === 'user' && Array.isArray(lastMessage.content)) {
    lastMessage.content.push(block);
    return;
  }

  messages.push({ role: 'user', content: [block] });
};

const translateResponsesInput = async (input: string | ResponseInputItem[], loadRemoteImage: RemoteImageLoader): Promise<{ messages: MessagesMessage[]; systemParts: string[] }> => {
  if (typeof input === 'string') {
    return {
      messages: [{ role: 'user', content: input }],
      systemParts: [],
    };
  }

  const messages: MessagesMessage[] = [];
  const systemParts: string[] = [];

  for (const item of input) {
    switch (item.type) {
    case 'message':
      if (item.role === 'system' || item.role === 'developer') {
        const text = extractSystemText(item);
        if (text) systemParts.push(text);
        continue;
      }

      messages.push(item.role === 'user' ? await translateUserMessage(item, loadRemoteImage) : translateAssistantMessage(item));
      break;
    case 'function_call':
      appendAssistantBlock(messages, {
        type: 'tool_use',
        id: item.call_id,
        name: item.name,
        input: parseToolArgumentsObject(item.arguments),
      });
      break;
    case 'function_call_output':
      appendUserBlock(messages, {
        type: 'tool_result',
        tool_use_id: item.call_id,
        content: item.output,
        is_error: item.status === 'incomplete' ? true : undefined,
      });
      break;
    case 'custom_tool_call':
      // Project the freeform invocation back into the wrapped function-tool
      // shape so the translated target sees a coherent history.
      appendAssistantBlock(messages, {
        type: 'tool_use',
        id: item.call_id,
        name: item.name,
        input: { input: item.input },
      });
      break;
    case 'custom_tool_call_output':
      appendUserBlock(messages, {
        type: 'tool_result',
        tool_use_id: item.call_id,
        content: item.output,
      });
      break;
    case 'reasoning': {
      const block = responsesReasoningToMessagesBlock(item);
      if (block) appendAssistantBlock(messages, block);
      break;
    }
    }
  }

  return { messages, systemParts };
};

const translateTools = (tools: ResponseTool[] | null | undefined, customToolNames: Set<string>): MessagesTool[] | undefined => {
  if (!tools || tools.length === 0) return undefined;

  // Translated Messages targets do not currently have a faithful bridge for
  // hosted/deferred Responses tools (`web_search`, `tool_search`, `namespace`,
  // `image_generation`, and future builtin names). Native Responses targets
  // receive those entries unchanged; this translator narrows to function and
  // Freeform `custom` tools until the translated semantics are defined.
  const out: MessagesTool[] = [];
  for (const tool of tools) {
    if (tool.type === 'function') {
      out.push({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters,
        strict: tool.strict,
      });
      continue;
    }
    if (tool.type === 'custom') {
      customToolNames.add(tool.name);
      out.push({
        name: tool.name,
        description: tool.description,
        input_schema: buildCustomToolInputSchema(tool.format),
      });
    }
  }
  return out.length > 0 ? out : undefined;
};

const translateToolChoice = (toolChoice: ResponseToolChoice | undefined): MessagesPayload['tool_choice'] => {
  if (!toolChoice) return undefined;

  if (typeof toolChoice === 'string') {
    switch (toolChoice) {
    case 'auto':
      return { type: 'auto' };
    case 'none':
      return { type: 'none' };
    case 'required':
      return { type: 'any' };
    default:
      return undefined;
    }
  }

  // Both function and wrapped custom tools land on the target as named tool
  // choices since they share the function-tool wire shape after translation.
  if (toolChoice.type === 'function' || toolChoice.type === 'custom') {
    return toolChoice.name ? { type: 'tool', name: toolChoice.name } : undefined;
  }
  return undefined;
};

export const translateResponsesToMessages = async (payload: ResponsesPayload, options: TranslateResponsesToMessagesOptions = {}): Promise<ResponsesToMessagesResult> => {
  const customToolNames = new Set<string>();
  // Tools first so customToolNames is populated before input history processing
  // sees the same trip's tool-name set (it doesn't currently consume the set,
  // but ordering reflects the wrap-then-project flow at one place).
  const tools = translateTools(payload.tools, customToolNames);
  const { messages, systemParts } = await translateResponsesInput(payload.input, options.loadRemoteImage ?? fetchRemoteImage);
  const system = [payload.instructions, ...systemParts].filter((part): part is string => Boolean(part)).join('\n\n');
  const effort = payload.reasoning?.effort;
  const maxTokens = payload.max_output_tokens ?? options.fallbackMaxOutputTokens ?? MESSAGES_FALLBACK_MAX_TOKENS;

  // Responses `metadata` is intentionally omitted on the Messages path instead
  // of being coerced into Anthropic `metadata.user_id`, prompt-cache, or safety
  // semantics.
  const target: MessagesPayload = {
    model: payload.model,
    messages,
    max_tokens: maxTokens,
    ...(system ? { system } : {}),
    ...(payload.temperature != null ? { temperature: payload.temperature } : {}),
    ...(payload.top_p != null ? { top_p: payload.top_p } : {}),
    stream: true,
    tools,
    tool_choice: translateToolChoice(payload.tool_choice),
    ...(effort === 'none' ? { thinking: { type: 'disabled' as const } } : effort ? { output_config: { effort } } : {}),
  };

  return { target, customToolNames };
};

export const buildTargetRequest = (payload: ResponsesPayload, options: { fallbackMaxOutputTokens?: number }): Promise<ResponsesToMessagesResult> =>
  translateResponsesToMessages(payload, options);
