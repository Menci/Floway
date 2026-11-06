import { klona } from 'klona/json';

import { filterAnthropicMessagesClientTools } from './client-tools.ts';
import { partitionAnthropicMessagesTurns, type AnthropicMessagesConversationTurn } from './conversation-turns.ts';
import { mergeAdjacentIRInputClientTurns } from '../../../ir/input/segments.ts';
import type {
  IRInputAssistantContentPart,
  IRInputRequest,
  IRInputSettings,
  IRInputTool,
  IRInputToolChoice,
  IRInputOutputFormat,
  IRInputAssistantItem,
  IRInputConversation,
  IRInputMedia,
  IRInputTextPart,
  IRInputToolResultContentPart,
  IRInputTurn,
  IRInputUserContentPart,
  IRInputClientItem,
} from '../../../ir/input/types.ts';
import { TranslatorInputError } from '../../../translator-input-error.ts';
import type {
  AnthropicMessagesClientTool,
  AnthropicMessagesImageBlock,
  AnthropicMessagesMetadataEx,
  AnthropicMessagesMessage,
  AnthropicMessagesPayload,
  AnthropicMessagesTextBlockParam,
  AnthropicMessagesToolResultBlock,
  AnthropicMessagesUserContentBlock,
} from '@floway-dev/protocols/anthropic-messages';
import { FAST_SERVICE_TIER } from '@floway-dev/protocols/common';

const DATA_URL = /^data:([^;,]+)?;base64,(.*)$/s;

const mediaFromUrl = (url: string): IRInputMedia => {
  const dataUrl = DATA_URL.exec(url);
  if (dataUrl === null) return { source_kind: 'url', url };
  const mediaType = dataUrl[1]?.trim();
  return { source_kind: 'base64', ...(mediaType === undefined || mediaType === '' ? {} : { media_type: mediaType }), data: dataUrl[2] };
};

const imageMedia = (source: AnthropicMessagesImageBlock['source']): IRInputMedia => {
  switch (source.type) {
  case 'base64': return { source_kind: 'base64', media_type: source.media_type, data: source.data };
  case 'url': return mediaFromUrl(source.url);
  case 'file': return { source_kind: 'file', file_id: source.file_id };
  }
};

const textBlocks = (content: string | readonly AnthropicMessagesTextBlockParam[]): IRInputTextPart[] => typeof content === 'string'
  ? content === '' ? [] : [{ type: 'text', text: content }]
  : content.map(block => {
      if (block.type !== 'text') throw new TranslatorInputError('Only text system content is supported.');
      return { type: 'text', text: block.text };
    });

// Messages carries file content as a `document` block whose source is a PDF,
// plain text, a URL, or an embedded content array. The input IR keeps the same two
// payload kinds it uses everywhere else.
const documentMedia = (block: Extract<AnthropicMessagesUserContentBlock, { type: 'document' }>): IRInputMedia => {
  const source = block.source;
  switch (source.type) {
  case 'base64': return { source_kind: 'base64', media_type: source.media_type, data: source.data };
  case 'url': return { source_kind: 'url', url: source.url };
  case 'file': return { source_kind: 'file', file_id: source.file_id };
  case 'text': return { source_kind: 'base64', media_type: source.media_type, data: source.data };
  case 'content':
    throw new TranslatorInputError('Cannot translate an inline content document; supply a base64, URL, text, or file source.');
  }
};

interface MessagePosition {
  readonly messageIdx: number;
  readonly blockIdx: number;
}

const userContentPart = (
  block: Exclude<AnthropicMessagesUserContentBlock, AnthropicMessagesToolResultBlock>,
  at: MessagePosition,
): IRInputUserContentPart => {
  switch (block.type) {
  case 'text': return { type: 'text', text: block.text };
  case 'image': return { type: 'image', image: imageMedia(block.source) };
  case 'document': return { type: 'file', file: documentMedia(block) };
  default: throw new TranslatorInputError(`messages.${at.messageIdx}.content.${at.blockIdx}.type: '${(block as { type: string }).type}' content blocks are not supported in user content.`);
  }
};

const toolResultPart = (block: AnthropicMessagesToolResultBlock['content'] extends string | undefined ? never : AnthropicMessagesToolResultBlock['content']): IRInputToolResultContentPart[] => block === undefined
  ? []
  : typeof block === 'string'
    ? [{ type: 'text', text: block }]
    : block.flatMap((part): IRInputToolResultContentPart[] => {
        if (part.type === 'text') return [{ type: 'text', text: part.text }];
        if (part.type === 'image') return [{ type: 'image', image: imageMedia(part.source) }];
        if (part.type === 'search_result') return [{ type: 'text', text: JSON.stringify([part]) }];
        throw new TranslatorInputError(`'${(part as { type: string }).type}' tool result content blocks are not supported.`);
      });

const userItems = (
  message: Exclude<AnthropicMessagesMessage, { role: 'assistant' }>,
  messageIdx: number,
): IRInputClientItem[] => {
  if (message.role === 'system') {
    if (typeof message.content !== 'string' && message.content.some(block => block.type !== 'text')) {
      throw new TranslatorInputError('Only text system content is supported.');
    }
    return [{ type: 'prompt', role: 'system', content: textBlocks(message.content as string | readonly AnthropicMessagesTextBlockParam[]) }];
  }
  if (typeof message.content === 'string') {
    return [{ type: 'message', content: message.content === '' ? [] : [{ type: 'text', text: message.content }] }];
  }

  const items: IRInputClientItem[] = [];
  const pending: IRInputUserContentPart[] = [];
  const flush = (): void => {
    if (pending.length === 0) return;
    items.push({ type: 'message', content: [...pending] });
    pending.length = 0;
  };

  // Messages keeps tool results inline with user content. Flat input IR items keep
  // the chronology and let each target regroup.
  for (const [blockIdx, block] of message.content.entries()) {
    if (block.type === 'tool_result') {
      flush();
      const output = toolResultPart(block.content);
      items.push({
        type: 'tool_result',
        call_id: block.tool_use_id,
        output: output.length === 0 ? '' : output.length === 1 && output[0].type === 'text' ? output[0].text : output,
        ...(block.is_error === true ? { is_error: true } : {}),
      });
      continue;
    }
    pending.push(userContentPart(block, { messageIdx, blockIdx }));
  }
  flush();
  return items;
};

// A server tool runs on Anthropic's own backend and its result is written into
// the assistant message by the API, so the client never answers it. Every target
// we write states one call and its result as a separate call/result pair anyway
// (Chat's `tool` message follows its `tool_calls`), so the pair has to become a
// turn boundary here.
//
// https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool
const SERVER_TOOL_RESULT_TYPES: ReadonlySet<string> = new Set([
  'web_search_tool_result',
  'web_fetch_tool_result',
  'code_execution_tool_result',
  'bash_code_execution_tool_result',
  'text_editor_code_execution_tool_result',
  'tool_search_tool_result',
]);

interface AnthropicMessagesAssistantSegments {
  // One entry per run of assistant items, each followed by the tool results the
  // server wrote into the same message. Reading the pairs in order reproduces
  // the block sequence: an assistant turn, then the client turn that answers it.
  readonly segments: readonly {
    readonly assistant: readonly IRInputAssistantItem[];
    readonly serverResults: readonly IRInputClientItem[];
  }[];
}

const assistantSegments = (message: Extract<AnthropicMessagesMessage, { role: 'assistant' }>, messageIdx: number): AnthropicMessagesAssistantSegments => {
  if (typeof message.content === 'string') {
    return { segments: [{ assistant: message.content === '' ? [] : [{ type: 'message', content: [{ type: 'text', text: message.content }] }], serverResults: [] }] };
  }

  const segments: { assistant: IRInputAssistantItem[]; serverResults: IRInputClientItem[] }[] = [];
  let assistant: IRInputAssistantItem[] = [];
  let serverResults: IRInputClientItem[] = [];
  const pending: IRInputAssistantContentPart[] = [];
  const flushText = (): void => {
    if (pending.length === 0) return;
    assistant.push({ type: 'message', content: [...pending] });
    pending.length = 0;
  };
  // A result closes the run it answers, so the pair becomes one segment.
  const flushSegment = (): void => {
    flushText();
    if (assistant.length === 0 && serverResults.length === 0) return;
    segments.push({ assistant, serverResults });
    assistant = [];
    serverResults = [];
  };

  for (const [blockIdx, block] of message.content.entries()) {
    if (SERVER_TOOL_RESULT_TYPES.has(block.type)) {
      flushText();
      const result = block as { tool_use_id: string; content: unknown };
      serverResults.push({
        type: 'tool_result',
        call_id: result.tool_use_id,
        output: JSON.stringify(result.content),
      });
      flushSegment();
      continue;
    }
    switch (block.type) {
    case 'text':
      pending.push({ type: 'text', text: block.text });
      break;
    case 'thinking':
      flushText();
      if (block.thinking !== '') assistant.push({ type: 'reasoning', summary: [block.thinking] });
      break;
    case 'redacted_thinking':
      // The redacted payload is an opaque, vendor-signed blob; the sidecar is
      // the only place that can carry it back to the same vendor.
      break;
    // A client tool and a server tool are the same fact to every target: a call
    // the rest of the conversation answers. Only the client answers a client
    // call, which is what the next real user turn carries.
    case 'tool_use':
    case 'server_tool_use':
      flushText();
      assistant.push({ type: 'function_call', call_id: block.id, name: block.name, arguments: JSON.stringify(block.input) });
      break;
    // Hosted results other than the ones above have no plain-tool spelling and
    // no cross-vendor counterpart.
    default:
      throw new TranslatorInputError(`messages.${messageIdx}.content.${blockIdx}.type: '${(block as { type: string }).type}' assistant content blocks are not supported on this model`);
    }
  }
  flushSegment();
  return { segments };
};

export const anthropicMessagesSystemToIR = (system: AnthropicMessagesPayload['system']): IRInputTurn | undefined => {
  if (system === undefined) return undefined;
  const content = textBlocks(system);
  return content.length === 0 ? undefined : { kind: 'client', items: [{ type: 'prompt', role: 'system', content }] };
};

/** Whether a turn carries reasoning only the sidecar can restore. */
export const anthropicMessagesDropsReasoning = (turn: AnthropicMessagesConversationTurn): boolean => turn.role === 'assistant'
  && turn.items.some(message => Array.isArray(message.content) && message.content.some(block => block.type === 'redacted_thinking'));

export const anthropicMessagesTurnToIR = (
  turn: AnthropicMessagesConversationTurn,
  firstMessageIndex = 0,
): IRInputTurn[] => {
  if (turn.role === 'assistant') {
    const turns: IRInputTurn[] = [];
    for (const [index, message] of turn.items.entries()) {
      for (const segment of assistantSegments(message, firstMessageIndex + index).segments) {
        // The pair a server tool states is one call and the result written into
        // the same message, so the result becomes the client turn that answers
        // it before the next run of assistant content begins.
        if (segment.assistant.length > 0) turns.push({ kind: 'assistant', items: segment.assistant });
        if (segment.serverResults.length > 0) turns.push({ kind: 'client', items: segment.serverResults });
      }
    }
    return turns;
  }
  return [{
    kind: 'client',
    items: turn.items.flatMap((message, index) => {
      if (message.role !== 'user' && message.role !== 'system') {
        throw new TranslatorInputError(`messages.${firstMessageIndex + index}.role: role '${(message as { role: string }).role}' is not supported on this model`);
      }
      return userItems(message, firstMessageIndex + index);
    }),
  }];
};

export const anthropicMessagesInputToIR = (payload: AnthropicMessagesPayload): IRInputConversation => {
  const turns: IRInputTurn[] = [];
  // Messages' top-level system is the same concept as a leading system item.
  const system = anthropicMessagesSystemToIR(payload.system);
  if (system !== undefined) turns.push(system);

  let messageIndex = 0;
  for (const turn of partitionAnthropicMessagesTurns(payload.messages)) {
    turns.push(...anthropicMessagesTurnToIR(turn, messageIndex));
    messageIndex += turn.items.length;
  }
  // A server tool's result becomes a client turn of its own; when the next real
  // client message already is one, the two state the same turn.
  return { turns: mergeAdjacentIRInputClientTurns(turns) };
};

/**
 * Messages states one ceiling, `max_tokens`, and its structured-output schema
 * lives in `output_config.format`. `top_k` is a Messages-only sampling knob.
 */
// A Messages client declaration carries a JSON Schema under `input_schema` and
// states both callable kinds with the same shape, so the arm is the neutral one
// every target can express.
const toolToIR = (tool: AnthropicMessagesClientTool): IRInputTool => {
  const format = tool.input_schema as { type?: unknown } & Record<string, unknown>;
  return {
    type: 'function',
    name: tool.name,
    ...(tool.description === undefined ? {} : { description: tool.description }),
    ...(format === undefined ? {} : { parameters: klona(tool.input_schema) as unknown as Readonly<Record<string, unknown>> }),
    ...(tool.strict === undefined ? {} : { strict: tool.strict }),
  };
};

const toolChoiceToIR = (choice: NonNullable<AnthropicMessagesPayload['tool_choice']>, declarations: readonly IRInputTool[]): IRInputToolChoice => {
  switch (choice.type) {
  case 'auto': return 'auto';
  case 'any': return 'required';
  case 'none': return 'none';
  default: {
    // A selector names a declaration the same request supplies; a request that
    // points at nothing cannot be translated into any target's vocabulary.
    const name = (choice as { name: string }).name;
    if (!declarations.some(tool => tool.name === name)) {
      throw new TranslatorInputError(`Anthropic Messages tool_choice names an undeclared tool: ${String(name)}`);
    }
    return { type: 'function', name };
  }
  }
};

export const anthropicMessagesToolsToIR = (payload: AnthropicMessagesPayload): Pick<IRInputRequest, 'tools' | 'tool_choice'> => {
  const clientTools = filterAnthropicMessagesClientTools(payload.tools);
  const declarations = clientTools === undefined ? [] : clientTools.map(toolToIR);
  // A selector is validated against the declarations either way: dropping one
  // that names nothing would widen what the model may call.
  const toolChoice = payload.tool_choice == null ? undefined : toolChoiceToIR(payload.tool_choice, declarations);
  return {
    ...(declarations.length === 0 ? {} : { tools: declarations }),
    ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
  };
};

export const anthropicMessagesSettingsToIR = (payload: AnthropicMessagesPayload): IRInputSettings => {
  const format = payload.output_config?.format;
  // Messages' structured-output schema is already strict by contract, so the
  // fact is stated here rather than left for a target to invent. It states no
  // name, while the OpenAI wires require one; this is the established spelling.
  // https://platform.claude.com/docs/en/build-with-claude/structured-outputs
  const outputFormat: IRInputOutputFormat | undefined = format?.type === 'json_schema'
    ? { type: 'json_schema', name: 'messages_response', schema: klona(format.schema), strict: true }
    : undefined;

  const reasoningEffort = reasoningEffortFromAnthropicMessages(payload);
  const serviceTier = serviceTierFromAnthropicMessages(payload);
  const metadata = metadataFromAnthropicMessages(payload.metadata as AnthropicMessagesMetadataEx | undefined);
  return {
    model: payload.model,
    stream: payload.stream === true,
    ...(payload.temperature == null ? {} : { temperature: payload.temperature }),
    ...(payload.top_p == null ? {} : { top_p: payload.top_p }),
    ...(payload.top_k == null ? {} : { top_k: payload.top_k }),
    ...(payload.stop_sequences == null ? {} : { stop: [...payload.stop_sequences] }),
    ...(payload.max_tokens == null ? {} : { max_output_tokens: payload.max_tokens }),
    ...(outputFormat === undefined ? {} : { output_format: outputFormat }),
    ...(serviceTier === undefined ? {} : { service_tier: serviceTier }),
    ...(metadata === undefined ? {} : { metadata }),
    // Messages splits one reasoning axis across three controls: a level, an off
    // switch, and a token budget. The level and the off switch are the same axis
    // every other protocol states as an effort, and the budget is its own
    // quantity that a source may state without a level.
    ...(reasoningEffort === undefined ? {} : { reasoning_effort: reasoningEffort }),
    ...(payload.thinking?.type === 'enabled' ? { reasoning_budget: payload.thinking.budget_tokens } : {}),
    ...(payload.thinking?.type === 'adaptive' ? { reasoning_dynamic: true } : {}),
  };
};

// Messages admits any JSON value as a metadata tag while the IR states string
// pairs, so a value with no string spelling is a caller error rather than a
// silent drop. `user_id: null` is Messages' way of stating no value at all.
const metadataFromAnthropicMessages = (metadata: AnthropicMessagesMetadataEx | undefined): Record<string, string> | undefined => {
  if (metadata === undefined) return undefined;
  const entries = Object.entries(metadata).flatMap(([key, value]): [string, string][] => {
    if (value == null) return [];
    if (typeof value !== 'string') throw new TranslatorInputError(`Cannot translate Anthropic Messages metadata field '${key}' to a string metadata value.`);
    return [[key, value]];
  });
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
};

// Messages states the accelerated lane as `speed` and the general lane as
// `service_tier`; every other protocol names both with the one tier string, so
// `speed` wins when a request states both.
// https://docs.claude.com/en/build-with-claude/fast-mode
const serviceTierFromAnthropicMessages = (payload: AnthropicMessagesPayload): string | undefined => {
  if (payload.speed === 'fast') return FAST_SERVICE_TIER;
  // `standard` is the default lane, which a target already assumes.
  if (payload.speed === 'standard') return undefined;
  return payload.service_tier ?? undefined;
};

// A level stated outright wins over the one a thinking mode implies, because the
// caller wrote it explicitly while the mode only bounds it.
const reasoningEffortFromAnthropicMessages = (payload: AnthropicMessagesPayload): string | undefined => {
  if (payload.output_config?.effort != null) return payload.output_config.effort;
  if (payload.thinking?.type === 'disabled') return 'none';
  if (payload.thinking?.type === 'enabled' || payload.thinking?.type === 'adaptive') return 'medium';
  return undefined;
};
