import { anthropicMessagesThinkingBlockFromOpenAIChatCompletionsScalarReasoning } from '../shared/openai-chat-completions-and-anthropic-messages/reasoning.ts';
import { applyLastMessageCacheBreakpoint, applyLastSystemCacheBreakpoint, applyLastToolCacheBreakpoint } from '../shared/via-anthropic-messages/cache-breakpoints.ts';
import { anthropicMessagesReasoningFieldsFromEffort } from '../shared/via-anthropic-messages/reasoning-effort.ts';
import { resolveImageUrlToAnthropicMessagesImage, unavailableRemoteImageLoader } from '../shared/via-anthropic-messages/remote-images.ts';
import { anthropicMessagesServiceTierFieldsFromOpenAI } from '../shared/via-anthropic-messages/service-tier.ts';
import { parseToolArgumentsObject } from '../shared/via-anthropic-messages/tool-arguments.ts';
import { TranslatorInputError } from '../translator-input-error.ts';
import type { RemoteImageLoader } from '../types.ts';
import { ANTHROPIC_MESSAGES_FALLBACK_MAX_TOKENS, type AnthropicMessagesAssistantInputContentBlock, type AnthropicMessagesMessage, type AnthropicMessagesPayload, type AnthropicMessagesTextBlock, type AnthropicMessagesUserContentBlock } from '@floway-dev/protocols/anthropic-messages';
import type { OpenAIChatCompletionsPayload, OpenAIChatCompletionsMessage, OpenAIChatCompletionsTool } from '@floway-dev/protocols/openai-chat-completions';

interface BuildTargetRequestOptions {
  loadRemoteImage?: RemoteImageLoader;
  /**
   * Preferred cap used when the source payload omits `max_tokens`. Callers in
   * the data plane forward the model's advertised `/models` output cap so the
   * translated Anthropic Messages request reflects the upstream-known limit rather than
   * being silently capped by a target-side default later.
   */
  fallbackMaxOutputTokens?: number;
}

const buildAssistantBlocks = (message: OpenAIChatCompletionsMessage): AnthropicMessagesAssistantInputContentBlock[] => {
  const blocks: AnthropicMessagesAssistantInputContentBlock[] = [];
  const thinkingBlock = anthropicMessagesThinkingBlockFromOpenAIChatCompletionsScalarReasoning(message.reasoning_text, message.reasoning_opaque);

  if (thinkingBlock) blocks.push(thinkingBlock);

  if (typeof message.content === 'string') {
    if (message.content) blocks.push({ type: 'text', text: message.content });
  } else if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (part.type === 'text') blocks.push({ type: 'text', text: part.text });
      else if (part.type === 'refusal') blocks.push({ type: 'text', text: part.refusal });
    }
  }

  if (message.refusal) blocks.push({ type: 'text', text: message.refusal });

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

const appendUserBlocks = (messages: AnthropicMessagesMessage[], blocks: AnthropicMessagesUserContentBlock[]): void => {
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

const convertUserContent = async (message: OpenAIChatCompletionsMessage, loadRemoteImage: RemoteImageLoader): Promise<AnthropicMessagesUserContentBlock[]> => {
  if (typeof message.content === 'string') {
    return [{ type: 'text', text: message.content }];
  }

  if (!Array.isArray(message.content)) {
    return [{ type: 'text', text: '' }];
  }

  const resolved = await Promise.all(
    message.content.map(part => {
      if (part.type === 'text') {
        return Promise.resolve({ type: 'text', text: part.text } as AnthropicMessagesUserContentBlock);
      }

      if (part.type === 'image_url') {
        return resolveImageUrlToAnthropicMessagesImage(part.image_url.url, loadRemoteImage);
      }

      throw new TranslatorInputError(`Invalid '${(part as { type: string }).type}' content part. Only 'text' and 'image_url' are supported in user content.`);
    }),
  );

  const blocks = resolved.filter((block): block is AnthropicMessagesUserContentBlock => block !== null);

  return blocks.length > 0 ? blocks : [{ type: 'text', text: '' }];
};

// Anthropic's Anthropic Messages system field (top-level `AnthropicMessagesPayload.system` and
// inline `AnthropicMessagesSystemMessage.content`) accepts only text. Image parts in
// system / developer messages are rejected here at the translator boundary so
// the caller hits an explicit failure instead of having the image silently
// dropped on the wire. Returns blocks (possibly empty) so the hoist and
// inline call sites share one shape.
const convertSystemContent = (content: OpenAIChatCompletionsMessage['content']): AnthropicMessagesTextBlock[] => {
  if (typeof content === 'string') {
    return content ? [{ type: 'text', text: content }] : [];
  }
  if (!Array.isArray(content)) return [];

  const blocks: AnthropicMessagesTextBlock[] = [];
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

const buildAnthropicMessagesInput = async (messages: OpenAIChatCompletionsMessage[], loadRemoteImage: RemoteImageLoader): Promise<AnthropicMessagesMessage[]> => {
  const result: AnthropicMessagesMessage[] = [];

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
      // `rewrite-mid-conv-system-to-user` interceptor flag is the safety
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

const translateOpenAIChatCompletionsTools = (tools: OpenAIChatCompletionsTool[]): AnthropicMessagesPayload['tools'] =>
  tools.map(tool => ({
    name: tool.function.name,
    description: tool.function.description,
    input_schema: tool.function.parameters ?? { type: 'object', properties: {} },
    ...(tool.function.strict !== undefined ? { strict: tool.function.strict } : {}),
  }));

const translateOpenAIChatCompletionsToolChoice = (toolChoice: NonNullable<OpenAIChatCompletionsPayload['tool_choice']>): AnthropicMessagesPayload['tool_choice'] => {
  if (typeof toolChoice === 'string') return CHAT_TOOL_CHOICES[toolChoice];

  return { type: 'tool', name: toolChoice.function.name };
};

const CHAT_TOOL_CHOICES = {
  auto: { type: 'auto' },
  none: { type: 'none' },
  required: { type: 'any' },
} satisfies Record<Extract<OpenAIChatCompletionsPayload['tool_choice'], string>, AnthropicMessagesPayload['tool_choice']>;

export const buildTargetRequest = async (payload: OpenAIChatCompletionsPayload, options: BuildTargetRequestOptions = {}): Promise<AnthropicMessagesPayload> => {
  // Hoist the leading contiguous run of system/developer messages to
  // AnthropicMessagesPayload.system, preserving each ContentPart text as its own
  // AnthropicMessagesTextBlock so part boundaries survive the hoist. Non-leading
  // system/developer messages stay inline as AnthropicMessagesSystemMessage at their
  // chronological position.
  const systemBlocks: AnthropicMessagesTextBlock[] = [];
  let prefixEnd = 0;
  for (const message of payload.messages) {
    if (message.role !== 'system' && message.role !== 'developer') break;
    systemBlocks.push(...convertSystemContent(message.content));
    prefixEnd++;
  }

  const messages = await buildAnthropicMessagesInput(payload.messages.slice(prefixEnd), options.loadRemoteImage ?? unavailableRemoteImageLoader);

  const maxTokens = payload.max_tokens ?? options.fallbackMaxOutputTokens ?? ANTHROPIC_MESSAGES_FALLBACK_MAX_TOKENS;
  const tools = payload.tools?.length ? translateOpenAIChatCompletionsTools(payload.tools) : undefined;
  applyLastSystemCacheBreakpoint(systemBlocks);
  applyLastToolCacheBreakpoint(tools);
  applyLastMessageCacheBreakpoint(messages);

  // Merge OpenAI Chat Completions `reasoning_effort` + `response_format` into a single Anthropic Messages
  // `output_config` so a chat-source structured-output request survives
  // routing through an Anthropic Messages target. `reasoning_effort: 'none'` lands on
  // `thinking` instead of `output_config`, and `format` still rides along.
  //
  // OpenAI Chat Completions nests json_schema details (`response_format = { type: 'json_schema',
  // json_schema: { schema } }`); `json_object` / `text` / absent have no
  // Anthropic Messages equivalent and drop.
  const { thinking, effort: reasoningEffort } = anthropicMessagesReasoningFieldsFromEffort(payload.reasoning_effort);
  const responseFormat = payload.response_format;
  const jsonSchema = responseFormat?.type === 'json_schema' ? (responseFormat.json_schema as Record<string, unknown> | undefined) : undefined;
  const formatSchema =
    jsonSchema?.schema && typeof jsonSchema.schema === 'object' && !Array.isArray(jsonSchema.schema) ? (jsonSchema.schema as Record<string, unknown>) : undefined;
  const outputConfig: NonNullable<AnthropicMessagesPayload['output_config']> = {};
  if (reasoningEffort !== undefined) outputConfig.effort = reasoningEffort;
  if (formatSchema) outputConfig.format = { type: 'json_schema', schema: formatSchema };
  const hasOutputConfig = Object.keys(outputConfig).length > 0;

  const serviceTierFields = anthropicMessagesServiceTierFieldsFromOpenAI(payload.service_tier);

  // Leave OpenAI `user` and generic metadata out of the Anthropic Messages fallback instead
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
    ...(payload.tool_choice != null ? { tool_choice: translateOpenAIChatCompletionsToolChoice(payload.tool_choice) } : {}),
    ...(thinking ? { thinking } : {}),
    ...(hasOutputConfig ? { output_config: outputConfig } : {}),
    ...serviceTierFields,
  };
};
