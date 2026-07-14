import { parseToolArgumentsObject } from '../shared/messages/tool-arguments.ts';
import { responsesReasoningToMessagesUpstreamBlock } from '../shared/messages-and-responses/reasoning.ts';
import { buildCustomToolInputSchema } from '../shared/responses-via/custom-tool-wrap.ts';
import { rejectProgramCaller, rejectProgrammaticResponsesPayload } from '../shared/responses-via/programmatic-tooling.ts';
import { applyLastMessageCacheBreakpoint, applyLastSystemCacheBreakpoint, applyLastToolCacheBreakpoint } from '../shared/via-messages/cache-breakpoints.ts';
import { type RemoteImageLoader, resolveImageUrlToMessagesImage, unavailableRemoteImageLoader } from '../shared/via-messages/remote-images.ts';
import { canonicalizeResponsesPayload } from '../shared/via-responses/responses-items.ts';
import { TranslatorInputError } from '../translator-input-error.ts';
import {
  MESSAGES_FALLBACK_MAX_TOKENS,
  type MessagesAssistantContentBlock,
  type MessagesAssistantMessage,
  type MessagesMessage,
  type MessagesPayload,
  type MessagesTextBlock,
  type MessagesTool,
  type MessagesToolResultBlock,
  type MessagesToolResultContentBlock,
  type MessagesUserContentBlock,
  type MessagesUserMessage,
} from '@floway-dev/protocols/messages';
import type {
  ResponsesInputContent,
  ResponsesInputImage,
  ResponsesInputItem,
  ResponsesInputMessage,
  ResponsesInputText,
  ResponsesRequestPayload,
  ResponsesTool,
  ResponsesToolChoice,
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

const translateUserMessage = async (message: ResponsesInputMessage, loadRemoteImage: RemoteImageLoader): Promise<MessagesUserMessage> => {
  if (typeof message.content === 'string') {
    return { role: 'user', content: message.content };
  }

  const content: MessagesUserContentBlock[] = [];

  for (const block of message.content) {
    if (block.type === 'input_text') {
      content.push({ type: 'text', text: (block as ResponsesInputText).text });
      continue;
    }

    if (block.type === 'input_file') {
      throw new TranslatorInputError('Cannot translate input_file message content to Messages.');
    }

    if (block.type !== 'input_image') continue;

    const imageUrl = (block as ResponsesInputImage).image_url;
    if (typeof imageUrl !== 'string') {
      throw new TranslatorInputError('Cannot translate file_id-only image content to Messages.');
    }
    const image = await resolveImageUrlToMessagesImage(imageUrl, loadRemoteImage);
    if (image) content.push(image);
  }

  return { role: 'user', content: content.length > 0 ? content : '' };
};

// Multimodal `function_call_output` outputs carry the same content parts as a
// user message; map them to Messages tool_result blocks (which natively carry
// image blocks) rather than flattening images away.
const translateToolOutput = async (output: string | ResponsesInputContent[], loadRemoteImage: RemoteImageLoader): Promise<string | MessagesToolResultContentBlock[]> => {
  if (typeof output === 'string') return output;

  const blocks: MessagesToolResultContentBlock[] = [];
  for (const part of output) {
    if (part.type === 'input_image') {
      if (typeof part.image_url !== 'string') {
        throw new TranslatorInputError('Cannot translate file_id-only image tool output to Messages.');
      }
      const image = await resolveImageUrlToMessagesImage(part.image_url, loadRemoteImage);
      if (image) blocks.push(image);
    } else if (part.type === 'input_file') {
      throw new TranslatorInputError('Cannot translate input_file tool output to Messages.');
    } else {
      blocks.push({ type: 'text', text: part.text });
    }
  }

  return blocks.length > 0 ? blocks : '';
};

const translateAssistantMessage = (message: ResponsesInputMessage): MessagesAssistantMessage => {
  if (typeof message.content === 'string') {
    return { role: 'assistant', content: message.content };
  }

  const content: MessagesAssistantContentBlock[] = [];

  for (const block of message.content) {
    if (block.type === 'input_image') {
      throw new TranslatorInputError('Cannot translate input_image assistant content to Messages.');
    }
    if (block.type === 'input_file') {
      throw new TranslatorInputError('Cannot translate input_file assistant content to Messages.');
    }
    if (block.type === 'input_text' || block.type === 'output_text') {
      content.push({ type: 'text', text: (block as ResponsesInputText).text });
    }
  }

  return { role: 'assistant', content: content.length > 0 ? content : '' };
};

// Anthropic's Messages system field (top-level `MessagesPayload.system` and
// inline `MessagesSystemMessage.content`) accepts only text. Image parts in
// system / developer Responses input messages are rejected here at the
// translator boundary so the caller hits an explicit failure instead of
// having the image silently dropped on the wire.
const responsesSystemBlocks = (message: ResponsesInputMessage): MessagesTextBlock[] => {
  if (typeof message.content === 'string') {
    return message.content ? [{ type: 'text', text: message.content }] : [];
  }

  const blocks: MessagesTextBlock[] = [];
  for (const block of message.content) {
    if (block.type === 'input_image') {
      throw new TranslatorInputError(`Invalid 'input_image' content part in ${message.role} message. Only 'input_text' content parts are supported in ${message.role} messages on this model.`);
    }
    if (block.type !== 'input_text' && block.type !== 'output_text') {
      // Every non-text content variant must opt into translator behavior
      // rather than be silently dropped from system content.
      throw new TranslatorInputError(`Invalid content block type '${(block as { type: string }).type}' in ${message.role} message.`);
    }
    blocks.push({ type: 'text', text: block.text });
  }
  return blocks;
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

const translateResponsesInput = async (input: ResponsesInputItem[], loadRemoteImage: RemoteImageLoader): Promise<{ messages: MessagesMessage[]; systemBlocks: MessagesTextBlock[] }> => {
  // Hoist the leading contiguous run of system/developer input messages into
  // systemBlocks (→ top-level Messages.system), preserving each input_text
  // part as its own MessagesTextBlock so part boundaries survive the hoist.
  // Non-leading system/developer messages stay inline as MessagesSystemMessage.
  const systemBlocks: MessagesTextBlock[] = [];
  let prefixEnd = 0;
  for (const item of input) {
    if (item.type !== 'message' || (item.role !== 'system' && item.role !== 'developer')) break;
    systemBlocks.push(...responsesSystemBlocks(item));
    prefixEnd++;
  }

  const messages: MessagesMessage[] = [];

  for (const item of input.slice(prefixEnd)) {
    rejectProgramCaller(item);
    switch (item.type) {
    case 'message':
      switch (item.role) {
      case 'user':
        messages.push(await translateUserMessage(item, loadRemoteImage));
        break;
      case 'assistant':
        messages.push(translateAssistantMessage(item));
        break;
      case 'system':
      case 'developer': {
        // The leading prefix was lifted above; keep later instruction messages
        // inline to preserve chronology.
        const blocks = responsesSystemBlocks(item);
        messages.push({ role: 'system', content: blocks.length > 0 ? blocks : '' });
        break;
      }
      default:
        throw new TranslatorInputError(`Invalid role '${(item as { role: string }).role}' in input message.`);
      }
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
        content: await translateToolOutput(item.output, loadRemoteImage),
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
      if (typeof item.output !== 'string') {
        throw new TranslatorInputError(`Cannot translate multimodal custom_tool_call_output '${item.call_id}'.`);
      }
      appendUserBlock(messages, {
        type: 'tool_result',
        tool_use_id: item.call_id,
        content: item.output,
      });
      break;
    case 'reasoning': {
      const block = responsesReasoningToMessagesUpstreamBlock(item);
      if (block) appendAssistantBlock(messages, block);
      break;
    }
    case 'item_reference':
      throw new TranslatorInputError("Invalid input item type 'item_reference'.");
    case 'web_search_call':
      // The shim must translate echoed web_search_call input items
      // into function_call + function_call_output pairs before this
      // translator runs. Reaching here means the reverse path was
      // skipped.
      throw new TranslatorInputError("Invalid input item type 'web_search_call'.");
    case 'image_generation_call':
      throw new TranslatorInputError("Invalid input item type 'image_generation_call'.");
    default:
      // Exhaustiveness guard: a future ResponsesInputItem variant must
      // explicitly opt into translator behavior.
      throw new TranslatorInputError(`Invalid input item: ${JSON.stringify(item)}`);
    }
  }

  return { messages, systemBlocks };
};

const translateTools = (tools: ResponsesTool[] | null | undefined, customToolNames: Set<string>): MessagesTool[] | undefined => {
  // Translated Messages targets do not currently have a faithful bridge
  // for hosted/deferred Responses tools (`web_search`, `tool_search`,
  // `namespace`, `image_generation`, and future builtin names). Native
  // Responses targets receive those entries unchanged; this translator
  // narrows to function and Freeform `custom` tools, recording the latter
  // in `customToolNames` so the events translator can reverse the wrap.
  // The shim's web_search function tool reaches this code under
  // its resolved name as an ordinary function tool — no special carve-out
  // needed.
  const out: MessagesTool[] = [];

  for (const tool of tools ?? []) {
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

const translateToolChoice = (toolChoice: ResponsesToolChoice | null | undefined): MessagesPayload['tool_choice'] => {
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

export const translateResponsesToMessages = async (source: ResponsesRequestPayload, options: TranslateResponsesToMessagesOptions = {}): Promise<ResponsesToMessagesResult> => {
  const payload = canonicalizeResponsesPayload(source);
  rejectProgrammaticResponsesPayload(payload, 'Messages');
  const customToolNames = new Set<string>();
  const { messages, systemBlocks: hoistedSystemBlocks } = await translateResponsesInput(payload.input, options.loadRemoteImage ?? unavailableRemoteImageLoader);
  const tools = translateTools(payload.tools, customToolNames);
  // `payload.instructions` is the Responses canonical system field; leading
  // system/developer input items contribute additional blocks immediately
  // after it. Each source — the instructions field and each leading input
  // message — is preserved as its own MessagesTextBlock so the boundary
  // between "canonical instructions" and "leading input system" survives
  // and the downstream prompt cache sees stable per-source segments.
  const systemBlocks: MessagesTextBlock[] = [
    ...(payload.instructions ? [{ type: 'text' as const, text: payload.instructions }] : []),
    ...hoistedSystemBlocks,
  ];
  const effort = payload.reasoning?.effort;
  const maxTokens = payload.max_output_tokens ?? options.fallbackMaxOutputTokens ?? MESSAGES_FALLBACK_MAX_TOKENS;
  applyLastSystemCacheBreakpoint(systemBlocks);
  applyLastToolCacheBreakpoint(tools);
  applyLastMessageCacheBreakpoint(messages);

  // Merge reasoning effort + structured-output format into a single
  // `output_config`. `effort === 'none'` still maps to `thinking: {type:
  // 'disabled'}` (Anthropic's native disable shape), but `format` should
  // still ride along when present.
  //
  // Responses keeps json_schema details flat (`text.format = { type, schema }`);
  // a `text` format or absent config has no Messages equivalent and drops.
  const responsesFormat = payload.text?.format;
  const formatSchema =
    responsesFormat?.type === 'json_schema' && responsesFormat.schema && typeof responsesFormat.schema === 'object' && !Array.isArray(responsesFormat.schema)
      ? (responsesFormat.schema as Record<string, unknown>)
      : undefined;
  const outputConfig: NonNullable<MessagesPayload['output_config']> = {};
  if (effort && effort !== 'none') outputConfig.effort = effort;
  if (formatSchema) outputConfig.format = { type: 'json_schema', schema: formatSchema };
  const hasOutputConfig = Object.keys(outputConfig).length > 0;

  const thinking = effort === 'none' ? { type: 'disabled' as const } : undefined;

  // `service_tier: 'fast'` from the Responses caller maps to Anthropic's
  // `speed: 'fast'`; all other defined service_tier values pass through as
  // `service_tier` on the Messages wire (Anthropic accepts 'auto',
  // 'standard_only', and future literals).
  const serviceTierFields: Partial<MessagesPayload> =
    payload.service_tier === 'fast'
      ? { speed: 'fast' }
      : payload.service_tier != null
        ? { service_tier: payload.service_tier }
        : {};

  // Responses `metadata` is intentionally omitted on the Messages path;
  // not coerced into Anthropic metadata.user_id, prompt-cache, or safety
  // semantics.
  const target: MessagesPayload = {
    model: payload.model,
    messages,
    max_tokens: maxTokens,
    ...(systemBlocks.length > 0 ? { system: systemBlocks } : {}),
    ...(payload.temperature != null ? { temperature: payload.temperature } : {}),
    ...(payload.top_p != null ? { top_p: payload.top_p } : {}),
    stream: true,
    tools,
    tool_choice: translateToolChoice(payload.tool_choice),
    ...(thinking ? { thinking } : {}),
    ...(hasOutputConfig ? { output_config: outputConfig } : {}),
    ...serviceTierFields,
  };

  return { target, customToolNames };
};

export const buildTargetRequest = (payload: ResponsesRequestPayload, options: TranslateResponsesToMessagesOptions): Promise<ResponsesToMessagesResult> =>
  translateResponsesToMessages(payload, options);
