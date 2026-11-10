import { klona } from 'klona/json';

import { openaiResponsesReasoningToAnthropicMessagesUpstreamBlock } from './reasoning.ts';
import { roundTripAssistantTurn, warnDroppedUnrecognizedAssistantReasoning } from '../../../round-trip/resolve.ts';
import { parseJSONObject } from '../../../shared/json/object.ts';
import { TranslatorInputError } from '../../../translator-input-error.ts';
import type { SidecarCodec, RemoteImageLoader } from '../../../types.ts';
import { applyLastMessageCacheBreakpoint, applyLastSystemCacheBreakpoint, applyLastToolCacheBreakpoint } from '../../anthropic-messages/as-target/cache-breakpoints.ts';
import { anthropicMessagesReasoningFieldsFromEffort } from '../../anthropic-messages/as-target/reasoning-effort.ts';
import { resolveImageUrlToAnthropicMessagesImage } from '../../anthropic-messages/as-target/remote-images.ts';
import { anthropicMessagesToolInputSchema } from '../../anthropic-messages/as-target/tool-input-schema.ts';
import { restrictAllowedTools } from '../as-source/allowed-tools.ts';
import { partitionOpenAIResponsesTurns } from '../as-source/conversation-turns.ts';
import { flattenNamespaceTools, type NamespaceToolNames } from '../as-source/namespace-tools.ts';
import { rejectProgramCaller, rejectProgrammaticOpenAIResponsesPayload } from '../as-source/programmatic-tooling.ts';
import { collectOpenAIResponsesReplayContents, findOpenAIResponsesSidecarCarriers, isOpenAIResponsesEncryptedReasoning, verifyOpenAIResponsesTurnDigest } from '../as-source/round-trip.ts';
import { canonicalizeOpenAIResponsesPayload } from '../canonicalize-payload.ts';
import { buildCustomToolInputSchema } from '../common/custom-tool-wrap.ts';
import {
  ANTHROPIC_MESSAGES_FALLBACK_MAX_TOKENS,
  type AnthropicMessagesAssistantContentBlock,
  type AnthropicMessagesAssistantInputContentBlock,
  type AnthropicMessagesAssistantMessage,
  type AnthropicMessagesMessage,
  type AnthropicMessagesPayload,
  type AnthropicMessagesTextBlockParam,
  type AnthropicMessagesTool,
  type AnthropicMessagesToolResultBlock,
  type AnthropicMessagesToolResultContentBlock,
  type AnthropicMessagesUserContentBlock,
  type AnthropicMessagesUserMessage,
} from '@floway-dev/protocols/anthropic-messages';
import { isFastServiceTier } from '@floway-dev/protocols/common';
import type {
  OpenAIResponsesInputContent,
  OpenAIResponsesInputImage,
  CanonicalOpenAIResponsesInputItem,
  OpenAIResponsesInputMessageEx,
  CanonicalOpenAIResponsesText,
  OpenAIResponsesRequestPayloadEx,
  OpenAIResponsesTool,
  OpenAIResponsesToolChoice,
} from '@floway-dev/protocols/openai-responses';

interface BuildTargetRequestOptions {
  loadRemoteImage: RemoteImageLoader;
  /**
   * Preferred cap used when the source payload omits `max_output_tokens`.
   * Callers in the data plane forward the model's advertised `/models` output
   * cap so the translated Anthropic Messages request reflects the upstream-known limit
   * rather than being silently capped by a target-side default later.
   */
  fallbackMaxOutputTokens: number | undefined;
}

const parseToolArgumentsObject = (argumentsJson: string): Record<string, unknown> => {
  try {
    return parseJSONObject(argumentsJson);
  } catch {
    return { raw_arguments: argumentsJson };
  }
};

const anthropicServiceTierFieldsFromOpenAI = (serviceTier: string | null | undefined): Partial<AnthropicMessagesPayload> =>
  isFastServiceTier(serviceTier)
    ? { speed: 'fast' }
    : serviceTier != null
      ? { service_tier: serviceTier }
      : {};

export interface TargetRequestResult {
  target: AnthropicMessagesPayload;
  /**
   * Names of OpenAI Responses `custom` tools the request translator wrapped as
   * single-string function tools. Returned alongside the translated payload so
   * the trip's events translator can project wrapped function calls back into
   * `custom_tool_call` outputs.
   */
  customToolNames: Set<string>;
  namespaceToolNames: NamespaceToolNames;
}

const translateUserMessage = async (message: OpenAIResponsesInputMessageEx, loadRemoteImage: RemoteImageLoader): Promise<AnthropicMessagesUserMessage> => {
  if (typeof message.content === 'string') {
    return { role: 'user', content: message.content };
  }

  const content: AnthropicMessagesUserContentBlock[] = [];

  for (const block of message.content) {
    if (block.type === 'input_text') {
      content.push({ type: 'text', text: (block as CanonicalOpenAIResponsesText).text });
      continue;
    }

    if (block.type === 'input_file') {
      throw new TranslatorInputError('Cannot translate input_file message content to Anthropic Messages.');
    }

    if (block.type === 'refusal') {
      throw new TranslatorInputError('Cannot translate refusal content in a user message to Anthropic Messages.');
    }

    if (block.type !== 'input_image') continue;

    const imageUrl = (block as OpenAIResponsesInputImage).image_url;
    if (typeof imageUrl !== 'string') {
      throw new TranslatorInputError('Cannot translate file_id-only image content to Anthropic Messages.');
    }
    const image = await resolveImageUrlToAnthropicMessagesImage(imageUrl, loadRemoteImage);
    if (image) content.push(image);
  }

  return { role: 'user', content: content.length > 0 ? content : '' };
};

// Function and custom tool outputs both admit text, image, and file parts.
// Anthropic tool_result content natively carries images, so preserve them
// rather than flattening the output.
// https://github.com/openai/openai-node/blob/cf1b7e1cf7981ef79695c496caf14b6bb492f18e/src/resources/responses/responses.ts#L3610-L3621
// https://github.com/openai/openai-node/blob/cf1b7e1cf7981ef79695c496caf14b6bb492f18e/src/resources/responses/responses.ts#L3157-L3169
// https://github.com/anthropics/anthropic-sdk-typescript/blob/3c5d9c0c15bb847a628f3f2876ac09719abe3012/src/resources/messages/messages.ts#L3457-L3475
const translateToolOutput = async (output: string | OpenAIResponsesInputContent[], loadRemoteImage: RemoteImageLoader): Promise<string | AnthropicMessagesToolResultContentBlock[]> => {
  if (typeof output === 'string') return output;

  const blocks: AnthropicMessagesToolResultContentBlock[] = [];
  for (const part of output) {
    if (part.type === 'input_image') {
      if (typeof part.image_url !== 'string') {
        throw new TranslatorInputError('Cannot translate file_id-only image tool output to Anthropic Messages.');
      }
      const image = await resolveImageUrlToAnthropicMessagesImage(part.image_url, loadRemoteImage);
      if (image === null) {
        throw new TranslatorInputError('Cannot translate unavailable or unsupported image tool output to Anthropic Messages.');
      }
      blocks.push(image);
    } else if (part.type === 'input_file') {
      throw new TranslatorInputError('Cannot translate input_file tool output to Anthropic Messages.');
    } else if (part.type === 'refusal') {
      throw new TranslatorInputError('Cannot translate refusal content in a tool output to Anthropic Messages.');
    } else {
      blocks.push({ type: 'text', text: part.text });
    }
  }

  return blocks.length > 0 ? blocks : '';
};

const translateAssistantMessage = (message: OpenAIResponsesInputMessageEx): AnthropicMessagesAssistantMessage => {
  if (typeof message.content === 'string') {
    return { role: 'assistant', content: message.content };
  }

  const content: AnthropicMessagesAssistantInputContentBlock[] = [];

  for (const block of message.content) {
    if (block.type === 'input_image') {
      throw new TranslatorInputError('Cannot translate input_image assistant content to Anthropic Messages.');
    }
    if (block.type === 'input_file') {
      throw new TranslatorInputError('Cannot translate input_file assistant content to Anthropic Messages.');
    }
    if (block.type === 'refusal') {
      content.push({ type: 'text', text: block.refusal });
      continue;
    }
    if (block.type === 'input_text' || block.type === 'output_text') {
      content.push({ type: 'text', text: (block as CanonicalOpenAIResponsesText).text });
    }
  }

  return { role: 'assistant', content: content.length > 0 ? content : '' };
};

// Anthropic's Anthropic Messages system field (top-level `AnthropicMessagesPayload.system` and
// inline `AnthropicMessagesSystemMessage.content`) accepts only text. Image parts in
// system / developer OpenAI Responses input messages are rejected here at the
// translator boundary so the caller hits an explicit failure instead of
// having the image silently dropped on the wire.
const openaiResponsesSystemBlocks = (message: OpenAIResponsesInputMessageEx): AnthropicMessagesTextBlockParam[] => {
  if (typeof message.content === 'string') {
    return message.content ? [{ type: 'text', text: message.content }] : [];
  }

  const blocks: AnthropicMessagesTextBlockParam[] = [];
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

const appendAssistantBlock = (messages: AnthropicMessagesMessage[], block: AnthropicMessagesAssistantContentBlock): void => {
  const lastMessage = messages[messages.length - 1];

  if (lastMessage?.role === 'assistant' && Array.isArray(lastMessage.content)) {
    lastMessage.content.push(block);
    return;
  }

  messages.push({ role: 'assistant', content: [block] });
};

const appendUserBlock = (messages: AnthropicMessagesMessage[], block: AnthropicMessagesToolResultBlock): void => {
  const lastMessage = messages[messages.length - 1];

  if (lastMessage?.role === 'user' && Array.isArray(lastMessage.content)) {
    lastMessage.content.push(block);
    return;
  }

  messages.push({ role: 'user', content: [block] });
};

const translateTools = (
  tools: OpenAIResponsesTool[] | null | undefined,
  customToolNames: Set<string>,
): AnthropicMessagesTool[] | undefined => {
  const out: AnthropicMessagesTool[] = [];

  for (const tool of tools ?? []) {
    if (tool.type === 'function') {
      out.push({
        name: tool.name,
        // OpenAI Responses spells "this tool has no description" as an explicit
        // `null`; Anthropic Messages has no such spelling, so the key is dropped.
        ...(tool.description == null ? {} : { description: tool.description }),
        // Anthropic Messages has no spelling for "no schema" either: `input_schema` is
        // required, and forwarding `undefined` makes Anthropic reject the whole
        // request with a 400. The empty object schema is Anthropic's own
        // spelling for a tool that takes no arguments.
        // https://github.com/anthropics/anthropic-sdk-typescript/blob/3b45cd3b69c956ac63384fdb09ce1d8109f3fa80/src/resources/messages/messages.ts#L1845-L1852
        // https://github.com/anthropics/anthropic-sdk-typescript/blob/3b45cd3b69c956ac63384fdb09ce1d8109f3fa80/examples/managed-agents-self-hosted-sandbox-worker.ts#L34-L41
        input_schema: anthropicMessagesToolInputSchema(klona(tool.parameters) ?? { type: 'object', properties: {} }),
        ...(tool.strict == null ? {} : { strict: tool.strict }),
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
      continue;
    }
    throw new TranslatorInputError(`Cannot translate OpenAI Responses tool type '${tool.type}' to Anthropic Messages.`);
  }
  return out.length > 0 ? out : undefined;
};

const translateToolChoice = (
  toolChoice: OpenAIResponsesToolChoice | null | undefined,
): AnthropicMessagesPayload['tool_choice'] => {
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
      throw new TranslatorInputError(`Cannot translate OpenAI Responses tool choice '${toolChoice}' to Anthropic Messages.`);
    }
  }

  // Both function and wrapped custom tools land on the target as named tool
  // choices since they share the function-tool wire shape after translation.
  if (toolChoice.type === 'function' || toolChoice.type === 'custom') {
    return toolChoice.name ? { type: 'tool', name: toolChoice.name } : undefined;
  }
  throw new TranslatorInputError(`Cannot translate OpenAI Responses tool choice type '${toolChoice.type}' to Anthropic Messages.`);
};

export const buildTargetRequest = async (
  source: OpenAIResponsesRequestPayloadEx,
  codec: SidecarCodec,
  options: BuildTargetRequestOptions,
): Promise<TargetRequestResult> => {
  const canonical = canonicalizeOpenAIResponsesPayload(source);
  const { payload, names: namespaceToolNames, flattenInput } = flattenNamespaceTools(canonical);
  rejectProgrammaticOpenAIResponsesPayload(payload, 'Anthropic Messages');
  const customToolNames = new Set<string>();
  const allowed = restrictAllowedTools(payload.tools, payload.tool_choice);
  const tools = translateTools(allowed.tools, customToolNames);
  const hoistedSystemBlocks: AnthropicMessagesTextBlockParam[] = [];
  const hoistedItems = new Set<CanonicalOpenAIResponsesInputItem>();
  for (const item of canonical.input) {
    if (item.type === 'additional_tools' || item.type === 'tool_search_output') continue;
    if (item.type !== 'message' || (item.role !== 'system' && item.role !== 'developer')) break;
    hoistedSystemBlocks.push(...openaiResponsesSystemBlocks(item));
    hoistedItems.add(item);
  }
  const bareMessages = new Set<AnthropicMessagesMessage>();
  const translateAssistantTurn = (input: CanonicalOpenAIResponsesInputItem[]): AnthropicMessagesMessage[] => {
    const messages: AnthropicMessagesMessage[] = [];
    for (const item of flattenInput(input)) {
      rejectProgramCaller(item);
      switch (item.type) {
      case 'message':
        if (item.role !== 'assistant') throw new TranslatorInputError(`Invalid assistant message role '${item.role}'.`);
        messages.push(translateAssistantMessage(item));
        break;
      case 'function_call':
        appendAssistantBlock(messages, { type: 'tool_use', id: item.call_id, name: item.name, input: parseToolArgumentsObject(item.arguments) });
        break;
      case 'custom_tool_call':
        appendAssistantBlock(messages, { type: 'tool_use', id: item.call_id, name: item.name, input: { input: item.input } });
        break;
      case 'reasoning': {
        if (isOpenAIResponsesEncryptedReasoning(item)) {
          warnDroppedUnrecognizedAssistantReasoning('openaiResponses', 'anthropicMessages');
          break;
        }
        const block = openaiResponsesReasoningToAnthropicMessagesUpstreamBlock(item);
        if (block) appendAssistantBlock(messages, block);
        break;
      }
      case 'item_reference':
      case 'web_search_call':
      case 'image_generation_call':
        throw new TranslatorInputError(`Invalid input item type '${item.type}'.`);
      default:
        throw new TranslatorInputError(`Invalid input item: ${JSON.stringify(item)}`);
      }
    }
    for (const message of messages) bareMessages.add(message);
    return messages;
  };

  const translateNonAssistantInput = async (input: CanonicalOpenAIResponsesInputItem[], loadRemoteImage: RemoteImageLoader): Promise<AnthropicMessagesMessage[]> => {
    const messages: AnthropicMessagesMessage[] = [];
    for (const item of flattenInput(input).filter(item => !hoistedItems.has(item))) {
      rejectProgramCaller(item);
      switch (item.type) {
      case 'message':
        switch (item.role) {
        case 'user': messages.push(await translateUserMessage(item, loadRemoteImage)); break;
        case 'system':
        case 'developer': {
          const blocks = openaiResponsesSystemBlocks(item);
          messages.push({ role: 'system', content: blocks.length > 0 ? blocks : '' });
          break;
        }
        default: throw new TranslatorInputError(`Invalid role '${item.role}' in input message.`);
        }
        break;
      case 'function_call_output':
      case 'custom_tool_call_output':
        appendUserBlock(messages, {
          type: 'tool_result', tool_use_id: item.call_id,
          content: await translateToolOutput(item.output, loadRemoteImage),
          is_error: item.type === 'function_call_output' && item.status === 'incomplete' ? true : undefined,
        });
        break;
      case 'item_reference':
      case 'web_search_call':
      case 'image_generation_call':
        throw new TranslatorInputError(`Invalid input item type '${item.type}'.`);
      default:
        throw new TranslatorInputError(`Invalid input item: ${JSON.stringify(item)}`);
      }
    }
    for (const message of messages) bareMessages.add(message);
    return messages;
  };
  // `payload.instructions` is the OpenAI Responses canonical system field; leading
  // system/developer input items contribute additional blocks immediately
  // after it. Each source — the instructions field and each leading input
  // message — is preserved as its own AnthropicMessagesTextBlockParam so the boundary
  // between "canonical instructions" and "leading input system" survives
  // and the downstream prompt cache sees stable per-source segments.
  const systemBlocks: AnthropicMessagesTextBlockParam[] = [
    ...(payload.instructions ? [{ type: 'text' as const, text: payload.instructions }] : []),
    ...hoistedSystemBlocks,
  ];
  const effort = payload.reasoning?.effort;
  const maxTokens = payload.max_output_tokens ?? options.fallbackMaxOutputTokens ?? ANTHROPIC_MESSAGES_FALLBACK_MAX_TOKENS;
  applyLastSystemCacheBreakpoint(systemBlocks);
  applyLastToolCacheBreakpoint(tools);

  // Merge reasoning effort + structured-output format into a single
  // `output_config`. `effort === 'none'` still maps to `thinking: {type:
  // 'disabled'}` (Anthropic's native disable shape), but `format` should
  // still ride along when present.
  //
  // OpenAI Responses keeps json_schema details flat (`text.format = { type, schema }`);
  // a `text` format or absent config has no Anthropic Messages equivalent and drops.
  const openaiResponsesFormat = payload.text?.format;
  const formatSchema =
    openaiResponsesFormat?.type === 'json_schema' && openaiResponsesFormat.schema && typeof openaiResponsesFormat.schema === 'object' && !Array.isArray(openaiResponsesFormat.schema)
      ? (openaiResponsesFormat.schema as Record<string, unknown>)
      : undefined;
  const { thinking, effort: outputConfigEffort } = anthropicMessagesReasoningFieldsFromEffort(effort);
  const outputConfig: NonNullable<AnthropicMessagesPayload['output_config']> = {};
  if (outputConfigEffort !== undefined) outputConfig.effort = outputConfigEffort;
  if (formatSchema) outputConfig.format = { type: 'json_schema', schema: klona(formatSchema) };
  const hasOutputConfig = Object.keys(outputConfig).length > 0;

  // OpenAI's accelerated request lane maps to Anthropic's `speed: 'fast'`;
  // other service-tier values remain open strings.
  // https://docs.claude.com/en/build-with-claude/fast-mode
  // https://platform.openai.com/docs/guides/fast-mode
  const serviceTierFields = anthropicServiceTierFieldsFromOpenAI(payload.service_tier);

  // OpenAI Responses `metadata` is intentionally omitted on the Anthropic Messages path;
  // not coerced into Anthropic metadata.user_id, prompt-cache, or safety
  // semantics.
  const target: AnthropicMessagesPayload = {
    model: payload.model,
    messages: [],
    max_tokens: maxTokens,
    ...(systemBlocks.length > 0 ? { system: systemBlocks } : {}),
    ...(payload.temperature != null ? { temperature: payload.temperature } : {}),
    ...(payload.top_p != null ? { top_p: payload.top_p } : {}),
    stream: true,
    tools,
    tool_choice: translateToolChoice(allowed.choice),
    ...(thinking ? { thinking } : {}),
    ...(hasOutputConfig ? { output_config: outputConfig } : {}),
    ...serviceTierFields,
  };

  for (const turn of partitionOpenAIResponsesTurns(canonical.input)) {
    if (turn.role !== 'assistant') { target.messages.push(...await translateNonAssistantInput(turn.items, options.loadRemoteImage)); continue; }
    const roundTrip = await roundTripAssistantTurn('openaiResponses', 'anthropicMessages', turn.items, codec, findOpenAIResponsesSidecarCarriers, verifyOpenAIResponsesTurnDigest, collectOpenAIResponsesReplayContents);
    target.messages.push(...(roundTrip ? [roundTrip.turn] : translateAssistantTurn(turn.items)));
  }
  applyLastMessageCacheBreakpoint(target.messages.filter(message => bareMessages.has(message)));
  return { target, customToolNames, namespaceToolNames };
};
