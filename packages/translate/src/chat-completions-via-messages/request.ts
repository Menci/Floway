import { messagesThinkingBlockFromChatCompletionsScalarReasoning } from '../shared/chat-completions-and-messages/reasoning.ts';
import { parseToolArgumentsObject } from '../shared/messages/tool-arguments.ts';
import { applyLastMessageCacheBreakpoint, applyLastSystemCacheBreakpoint, applyLastToolCacheBreakpoint } from '../shared/via-messages/cache-breakpoints.ts';
import { type RemoteImageLoader, resolveImageUrlToMessagesImage, unavailableRemoteImageLoader } from '../shared/via-messages/remote-images.ts';
import { TranslatorInputError } from '../translator-input-error.ts';
import type { ChatCompletionsPayload, ChatCompletionsMessage, ChatCompletionsTool } from '@floway-dev/protocols/chat-completions';
import { MESSAGES_FALLBACK_MAX_TOKENS, type MessagesAssistantContentBlock, type MessagesMessage, type MessagesPayload, type MessagesTextBlock, type MessagesUserContentBlock } from '@floway-dev/protocols/messages';

interface TranslateChatCompletionsToMessagesOptions {
  loadRemoteImage?: RemoteImageLoader;
  /**
   * Preferred cap used when the source payload omits `max_tokens`. Callers in
   * the data plane forward the model's advertised `/models` output cap so the
   * translated Messages request reflects the upstream-known limit rather than
   * being silently capped by a target-side default later.
   */
  fallbackMaxOutputTokens?: number;
}

const buildAssistantBlocks = (message: ChatCompletionsMessage): MessagesAssistantContentBlock[] => {
  const blocks: MessagesAssistantContentBlock[] = [];
  const thinkingBlock = messagesThinkingBlockFromChatCompletionsScalarReasoning(message.reasoning_text, message.reasoning_opaque);

  if (thinkingBlock) blocks.push(thinkingBlock);

  if (typeof message.content === 'string' && message.content) {
    blocks.push({ type: 'text', text: message.content });
  }

  for (const toolCall of message.tool_calls ?? []) {
    blocks.push({
      type: 'tool_use',
      id: toolCall.id,
      name: toolCall.function.name,
      input: parseToolArgumentsObject(toolCall.function.arguments),
    });
  }

  return blocks.length > 0 ? blocks : [{ type: 'text', text: '' }];
};

const appendUserBlocks = (messages: MessagesMessage[], blocks: MessagesUserContentBlock[]): void => {
  const lastMessage = messages[messages.length - 1];

  if (lastMessage?.role === 'user') {
    const existing = Array.isArray(lastMessage.content) ? lastMessage.content : [{ type: 'text' as const, text: lastMessage.content }];

    lastMessage.content = [...existing, ...blocks];
    return;
  }

  messages.push({
    role: 'user',
    content: blocks.length === 1 && blocks[0].type === 'text' ? blocks[0].text : blocks,
  });
};

const convertUserContent = async (message: ChatCompletionsMessage, loadRemoteImage: RemoteImageLoader): Promise<MessagesUserContentBlock[]> => {
  if (typeof message.content === 'string') {
    return [{ type: 'text', text: message.content }];
  }

  if (!Array.isArray(message.content)) {
    return [{ type: 'text', text: '' }];
  }

  const resolved = await Promise.all(
    message.content.map(part => {
      if (part.type === 'text') {
        return Promise.resolve({ type: 'text', text: part.text } as MessagesUserContentBlock);
      }

      if (part.type === 'image_url') {
        return resolveImageUrlToMessagesImage(part.image_url.url, loadRemoteImage);
      }

      throw new TranslatorInputError(`Invalid '${(part as { type: string }).type}' content part. Only 'text' and 'image_url' are supported in user content.`);
    }),
  );

  const blocks = resolved.filter((block): block is MessagesUserContentBlock => block !== null);

  return blocks.length > 0 ? blocks : [{ type: 'text', text: '' }];
};

// Anthropic's Messages system field (top-level `MessagesPayload.system` and
// inline `MessagesSystemMessage.content`) accepts only text. Image parts in
// system / developer messages are rejected here at the translator boundary so
// the caller hits an explicit failure instead of having the image silently
// dropped on the wire. Returns blocks (possibly empty) so the hoist and
// inline call sites share one shape.
const convertSystemContent = (content: ChatCompletionsMessage['content']): MessagesTextBlock[] => {
  if (typeof content === 'string') {
    return content ? [{ type: 'text', text: content }] : [];
  }
  if (!Array.isArray(content)) return [];

  const blocks: MessagesTextBlock[] = [];
  for (const part of content) {
    if (part.type === 'image_url') {
      throw new TranslatorInputError("Invalid 'image_url' content part in system or developer message. Only 'text' content parts are supported in system messages on this model.");
    }
    if (part.type === 'text') {
      blocks.push({ type: 'text', text: part.text });
    }
  }

  return blocks;
};

const buildMessagesInput = async (messages: ChatCompletionsMessage[], loadRemoteImage: RemoteImageLoader): Promise<MessagesMessage[]> => {
  const result: MessagesMessage[] = [];

  for (const message of messages) {
    switch (message.role) {
    case 'user':
      appendUserBlocks(result, await convertUserContent(message, loadRemoteImage));
      break;
    case 'assistant':
      result.push({
        role: 'assistant',
        content: buildAssistantBlocks(message),
      });
      break;
    case 'tool':
      if (!message.tool_call_id) {
        throw new TranslatorInputError("Missing required field 'tool_call_id' on a 'tool' role message.");
      }

      appendUserBlocks(result, [
        {
          type: 'tool_result',
          tool_use_id: message.tool_call_id,
          content: typeof message.content === 'string' ? message.content : '',
        },
      ]);
      break;
    case 'system':
    case 'developer': {
      // Inline path for non-leading system / developer (the leading prefix
      // was hoisted earlier). Anthropic upstreams diverge on inline
      // role:'system' here (Bedrock accepts it under placement rules;
      // Vertex rejects it outright), so the gateway's
      // `demote-interleaved-system-to-user` interceptor flag is the safety
      // net for any inline system that would otherwise reach an upstream
      // that does not accept it.
      const blocks = convertSystemContent(message.content);
      result.push({
        role: 'system',
        content: blocks.length > 0 ? blocks : '',
      });
      break;
    }
    default:
      throw new TranslatorInputError(`Invalid role '${message.role}'.`);
    }
  }

  return result;
};

const translateChatCompletionsTools = (tools: ChatCompletionsTool[]): MessagesPayload['tools'] =>
  tools.map(tool => ({
    name: tool.function.name,
    description: tool.function.description,
    input_schema: tool.function.parameters ?? { type: 'object', properties: {} },
    ...(tool.function.strict !== undefined ? { strict: tool.function.strict } : {}),
  }));

const translateChatCompletionsToolChoice = (toolChoice: NonNullable<ChatCompletionsPayload['tool_choice']>): MessagesPayload['tool_choice'] => {
  if (typeof toolChoice === 'string') return CHAT_TOOL_CHOICES[toolChoice];

  return { type: 'tool', name: toolChoice.function.name };
};

const CHAT_TOOL_CHOICES = {
  auto: { type: 'auto' },
  none: { type: 'none' },
  required: { type: 'any' },
} satisfies Record<Extract<ChatCompletionsPayload['tool_choice'], string>, MessagesPayload['tool_choice']>;

export const translateChatCompletionsToMessages = async (payload: ChatCompletionsPayload, options: TranslateChatCompletionsToMessagesOptions = {}): Promise<MessagesPayload> => {
  // Hoist the leading contiguous run of system/developer messages to
  // MessagesPayload.system, preserving each ContentPart text as its own
  // MessagesTextBlock so part boundaries survive the hoist. Non-leading
  // system/developer messages stay inline as MessagesSystemMessage at their
  // chronological position.
  const systemBlocks: MessagesTextBlock[] = [];
  let prefixEnd = 0;
  for (const message of payload.messages) {
    if (message.role !== 'system' && message.role !== 'developer') break;
    systemBlocks.push(...convertSystemContent(message.content));
    prefixEnd++;
  }

  const messages = await buildMessagesInput(payload.messages.slice(prefixEnd), options.loadRemoteImage ?? unavailableRemoteImageLoader);

  const maxTokens = payload.max_tokens ?? options.fallbackMaxOutputTokens ?? MESSAGES_FALLBACK_MAX_TOKENS;
  const tools = payload.tools?.length ? translateChatCompletionsTools(payload.tools) : undefined;
  applyLastSystemCacheBreakpoint(systemBlocks);
  applyLastToolCacheBreakpoint(tools);
  applyLastMessageCacheBreakpoint(messages);

  // Merge Chat `reasoning_effort` + `response_format` into a single Messages
  // `output_config` so a chat-source structured-output request survives
  // routing through a Messages target.
  //
  // Chat nests json_schema details (`response_format = { type: 'json_schema',
  // json_schema: { schema } }`); `json_object` / `text` / absent have no
  // Messages equivalent and drop.
  const reasoningEffort = payload.reasoning_effort && payload.reasoning_effort !== 'none' ? payload.reasoning_effort : undefined;
  const responseFormat = payload.response_format;
  const jsonSchema = responseFormat?.type === 'json_schema' ? (responseFormat.json_schema as Record<string, unknown> | undefined) : undefined;
  const formatSchema =
    jsonSchema?.schema && typeof jsonSchema.schema === 'object' && !Array.isArray(jsonSchema.schema) ? (jsonSchema.schema as Record<string, unknown>) : undefined;
  const outputConfig: NonNullable<MessagesPayload['output_config']> = {};
  if (reasoningEffort !== undefined) outputConfig.effort = reasoningEffort;
  if (formatSchema) outputConfig.format = { type: 'json_schema', schema: formatSchema };
  const hasOutputConfig = Object.keys(outputConfig).length > 0;

  // `service_tier: 'fast'` from the Chat Completions caller maps to
  // Anthropic's `speed: 'fast'`; all other defined service_tier values
  // pass through as `service_tier` on the Messages wire.
  const serviceTierFields: Partial<MessagesPayload> =
    payload.service_tier === 'fast'
      ? { speed: 'fast' }
      : payload.service_tier != null
        ? { service_tier: payload.service_tier }
        : {};

  // Leave OpenAI `user` and generic metadata out of the Messages fallback instead
  // of treating them as a backchannel for Anthropic `metadata.user_id`.
  return {
    model: payload.model,
    messages,
    max_tokens: maxTokens,
    ...(systemBlocks.length > 0 ? { system: systemBlocks } : {}),
    ...(payload.temperature != null ? { temperature: payload.temperature } : {}),
    ...(payload.top_p != null ? { top_p: payload.top_p } : {}),
    ...(payload.stop != null
      ? {
          stop_sequences: Array.isArray(payload.stop) ? payload.stop : [payload.stop],
        }
      : {}),
    stream: true,
    ...(tools ? { tools } : {}),
    ...(payload.tool_choice != null ? { tool_choice: translateChatCompletionsToolChoice(payload.tool_choice) } : {}),
    ...(hasOutputConfig ? { output_config: outputConfig } : {}),
    ...serviceTierFields,
  };
};

export const buildTargetRequest = (payload: ChatCompletionsPayload, options: TranslateChatCompletionsToMessagesOptions): Promise<MessagesPayload> =>
  translateChatCompletionsToMessages(payload, options);
