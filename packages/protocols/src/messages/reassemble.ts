import type {
  MessagesAssistantContentBlock,
  MessagesCodeExecutionToolResultBlock,
  MessagesContainerUploadBlock,
  MessagesFallbackBlock,
  MessagesRedactedThinkingBlock,
  MessagesRefusalStopDetails,
  MessagesResult,
  MessagesServerToolUseBlock,
  MessagesStreamEvent,
  MessagesTextCitation,
  MessagesThinkingBlock,
  MessagesToolUseBlock,
  MessagesUsage,
  MessagesToolSearchToolResultBlock,
  MessagesWebFetchToolResultBlock,
  MessagesWebSearchToolResultBlock,
} from './index.ts';
import { cloneMessagesUsageIterations } from './usage.ts';
import { isJsonObject } from '../common/json.ts';
import { captureExtras } from '../common/reassemble-extras.ts';

const citationIndex = (value: unknown, field: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError(`Messages citation ${field} must be a non-negative safe integer`);
  return value as number;
};

const citationTitle = (value: unknown, field: string): string | null => {
  if (value !== null && typeof value !== 'string') throw new TypeError(`Messages citation ${field} must be a string or null`);
  return value;
};

const citationFileId = (value: unknown): string | null | undefined => {
  if (value !== undefined && value !== null && typeof value !== 'string') throw new TypeError('Messages citation file_id must be a string or null');
  return value;
};

const normalizeMessagesTextCitation = (value: unknown): MessagesTextCitation => {
  if (!isJsonObject(value) || typeof value.type !== 'string') throw new TypeError('Messages text citation must be an object with a string type');
  if (value.cited_text !== undefined && typeof value.cited_text !== 'string') throw new TypeError('Messages citation cited_text must be a string');
  const original = structuredClone(value);

  switch (value.type) {
  case 'search_result_location': {
    const url = typeof value.url === 'string' ? value.url : typeof value.source === 'string' ? value.source : null;
    const start = citationIndex(value.start_block_index, 'start_block_index');
    const end = citationIndex(value.end_block_index, 'end_block_index');
    if (!url || end <= start) throw new TypeError('Messages search_result_location citation is malformed');
    const { source: _source, url: _url, ...extension } = original;
    return {
      ...extension,
      type: value.type,
      url,
      title: citationTitle(value.title, 'title'),
      search_result_index: citationIndex(value.search_result_index, 'search_result_index'),
      start_block_index: start,
      end_block_index: end,
      ...(typeof value.cited_text === 'string' ? { cited_text: value.cited_text } : {}),
    };
  }
  case 'web_search_result_location': {
    const url = typeof value.url === 'string' ? value.url : typeof value.source === 'string' ? value.source : null;
    if (!url || typeof value.encrypted_index !== 'string') throw new TypeError('Messages web_search_result_location citation is malformed');
    return {
      ...original,
      type: value.type,
      url,
      title: citationTitle(value.title, 'title'),
      encrypted_index: value.encrypted_index,
      ...(typeof value.cited_text === 'string' ? { cited_text: value.cited_text } : {}),
    };
  }
  case 'char_location': {
    const start = citationIndex(value.start_char_index, 'start_char_index');
    const end = citationIndex(value.end_char_index, 'end_char_index');
    if (typeof value.cited_text !== 'string' || end <= start) throw new TypeError('Messages char_location citation is malformed');
    return {
      ...original,
      type: value.type,
      cited_text: value.cited_text,
      document_index: citationIndex(value.document_index, 'document_index'),
      document_title: citationTitle(value.document_title, 'document_title'),
      start_char_index: start,
      end_char_index: end,
      ...('file_id' in value ? { file_id: citationFileId(value.file_id) } : {}),
    };
  }
  case 'content_block_location': {
    const start = citationIndex(value.start_block_index, 'start_block_index');
    const end = citationIndex(value.end_block_index, 'end_block_index');
    if (typeof value.cited_text !== 'string' || end <= start) throw new TypeError('Messages content_block_location citation is malformed');
    return {
      ...original,
      type: value.type,
      cited_text: value.cited_text,
      document_index: citationIndex(value.document_index, 'document_index'),
      document_title: citationTitle(value.document_title, 'document_title'),
      start_block_index: start,
      end_block_index: end,
      ...('file_id' in value ? { file_id: citationFileId(value.file_id) } : {}),
    };
  }
  case 'page_location': {
    const start = citationIndex(value.start_page_number, 'start_page_number');
    const end = citationIndex(value.end_page_number, 'end_page_number');
    if (typeof value.cited_text !== 'string' || end < start) throw new TypeError('Messages page_location citation is malformed');
    return {
      ...original,
      type: value.type,
      cited_text: value.cited_text,
      document_index: citationIndex(value.document_index, 'document_index'),
      document_title: citationTitle(value.document_title, 'document_title'),
      start_page_number: start,
      end_page_number: end,
      ...('file_id' in value ? { file_id: citationFileId(value.file_id) } : {}),
    };
  }
  default:
    throw new TypeError(`Unsupported Messages text citation type: ${value.type}`);
  }
};

const normalizeMessagesTextCitations = (value: unknown): MessagesTextCitation[] =>
  value === undefined || value === null
    ? []
    : Array.isArray(value)
      ? value.map(normalizeMessagesTextCitation)
      : (() => { throw new TypeError('Messages text citations must be an array'); })();

type MessagesTextBlockAccumulator = {
  type: 'text';
  text: string;
  citations: MessagesTextCitation[];
};

type MessagesToolUseBlockAccumulator = MessagesToolUseBlock & {
  inputJson: string;
};

const BLOCK_EXTRAS = Symbol('Messages block extras');

type MessagesBlockAccumulator = (
  | MessagesTextBlockAccumulator
  | MessagesToolUseBlockAccumulator
  | MessagesServerToolUseBlock
  | MessagesWebSearchToolResultBlock
  | MessagesThinkingBlock
  | MessagesRedactedThinkingBlock
  | MessagesFallbackBlock
  | MessagesWebFetchToolResultBlock
  | MessagesCodeExecutionToolResultBlock
  | MessagesToolSearchToolResultBlock
  | MessagesContainerUploadBlock
) & { [BLOCK_EXTRAS]?: Record<string, unknown> };

interface MessagesBlockState {
  accumulator: MessagesBlockAccumulator;
  stopped: boolean;
}

// Field-fidelity contract — see {@link captureExtras}. Anything an upstream
// emits on `message_start.message`, on a `content_block`, or on the assembled
// result top-level beyond the typed schema below survives by default.
const KNOWN_MESSAGE_KEYS = new Set(['id', 'type', 'role', 'content', 'model', 'stop_reason', 'stop_details', 'stop_sequence', 'usage']);
const KNOWN_BLOCK_KEYS_BY_TYPE: Record<string, ReadonlySet<string>> = {
  text: new Set(['type', 'text', 'citations']),
  tool_use: new Set(['type', 'id', 'name', 'input']),
  thinking: new Set(['type', 'thinking', 'signature']),
  redacted_thinking: new Set(['type', 'data']),
  server_tool_use: new Set(['type', 'id', 'name', 'input', 'caller']),
  web_search_tool_result: new Set(['type', 'tool_use_id', 'content']),
  fallback: new Set(['type', 'from', 'to', 'trigger']),
};
const FALLBACK_BLOCK_KNOWN = new Set(['type']);

const requiredNonEmptyString = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${field} must be a non-empty string`);
  return value;
};

const requiredString = (value: unknown, field: string): string => {
  if (typeof value !== 'string') throw new TypeError(`${field} must be a string`);
  return value;
};

const applyMessagesUsage = (usage: MessagesUsage, update: Partial<MessagesUsage> | undefined): void => {
  if (!update) return;

  if (update.input_tokens != null) usage.input_tokens = update.input_tokens;
  if (update.output_tokens != null) usage.output_tokens = update.output_tokens;
  if (update.cache_creation_input_tokens != null) {
    usage.cache_creation_input_tokens = update.cache_creation_input_tokens;
  }
  if (update.cache_read_input_tokens != null) {
    usage.cache_read_input_tokens = update.cache_read_input_tokens;
  }
  if (update.cache_creation != null) usage.cache_creation = { ...update.cache_creation };
  if (update.output_tokens_details != null) usage.output_tokens_details = { ...update.output_tokens_details };
  if (update.service_tier != null) usage.service_tier = update.service_tier;
  if (update.speed != null) usage.speed = update.speed;
  if (update.server_tool_use != null) {
    usage.server_tool_use = { ...update.server_tool_use };
  }
  if (update.iterations !== undefined) {
    usage.iterations = cloneMessagesUsageIterations(update.iterations);
  }
};

const createBlockAccumulator = (event: Extract<MessagesStreamEvent, { type: 'content_block_start' }>): MessagesBlockAccumulator => {
  const block = event.content_block;
  if (block.type === 'container_upload') {
    requiredNonEmptyString(block.file_id, 'Messages container_upload.file_id');
    return structuredClone(block);
  }
  if (block.type === 'web_fetch_tool_result'
    || block.type === 'code_execution_tool_result'
    || block.type === 'bash_code_execution_tool_result'
    || block.type === 'text_editor_code_execution_tool_result'
    || block.type === 'tool_search_tool_result') {
    requiredNonEmptyString(block.tool_use_id, `Messages ${block.type}.tool_use_id`);
    if (!isJsonObject(block.content)) throw new TypeError(`Messages ${block.type}.content must be an object`);
    return structuredClone(block);
  }
  const rawBlock = block as unknown as Record<string, unknown>;
  const knownKeys = KNOWN_BLOCK_KEYS_BY_TYPE[block.type] ?? FALLBACK_BLOCK_KNOWN;
  const extras: Record<string, unknown> = {};
  captureExtras(rawBlock, knownKeys, extras);
  const withExtras = <T extends MessagesBlockAccumulator>(acc: T): T =>
    Object.keys(extras).length > 0 ? Object.assign(acc, { [BLOCK_EXTRAS]: extras }) : acc;

  switch (block.type) {
  case 'text':
    return withExtras({
      type: 'text',
      text: requiredString(block.text, 'Messages text block text'),
      citations: normalizeMessagesTextCitations(block.citations),
    });
  case 'tool_use':
    requiredNonEmptyString(block.id, 'Messages tool_use.id');
    requiredNonEmptyString(block.name, 'Messages tool_use.name');
    if (!isJsonObject(block.input)) throw new TypeError('Upstream Messages tool input must be a JSON object');
    return withExtras({
      type: 'tool_use',
      id: block.id,
      name: block.name,
      input: structuredClone(block.input),
      inputJson: '',
    });
  case 'server_tool_use':
    requiredNonEmptyString(block.id, 'Messages server_tool_use.id');
    requiredNonEmptyString(block.name, 'Messages server_tool_use.name');
    return withExtras({
      type: 'server_tool_use',
      id: block.id,
      name: block.name,
      input: structuredClone(block.input),
      ...(block.caller !== undefined ? { caller: structuredClone(block.caller) } : {}),
    });
  case 'web_search_tool_result':
    requiredNonEmptyString(block.tool_use_id, 'Messages web_search_tool_result.tool_use_id');
    if (!Array.isArray(block.content) && !isJsonObject(block.content)) throw new TypeError('Messages web_search_tool_result.content must be an array or object');
    return withExtras({
      type: 'web_search_tool_result',
      tool_use_id: block.tool_use_id,
      content: structuredClone(block.content),
    });
  case 'thinking':
    return withExtras({
      type: 'thinking',
      thinking: requiredString(block.thinking, 'Messages thinking block thinking'),
      ...(block.signature !== undefined ? { signature: requiredString(block.signature, 'Messages thinking block signature') } : {}),
    });
  case 'redacted_thinking':
    return withExtras({ type: 'redacted_thinking', data: requiredString(block.data, 'Messages redacted_thinking.data') });
  case 'fallback':
    if (!isJsonObject(block.from) || typeof block.from.model !== 'string' || block.from.model.length === 0
      || !isJsonObject(block.to) || typeof block.to.model !== 'string' || block.to.model.length === 0
      || !isJsonObject(block.trigger) || block.trigger.type !== 'refusal') {
      throw new TypeError('Upstream Messages fallback block is malformed');
    }
    return withExtras({
      type: 'fallback',
      from: structuredClone(block.from),
      to: structuredClone(block.to),
      trigger: structuredClone(block.trigger),
    });
  default:
    throw new TypeError(`Unsupported Messages content block type: ${(block as { type?: unknown }).type as string}`);
  }
};

const applyBlockDelta = (block: MessagesBlockAccumulator | undefined, event: Extract<MessagesStreamEvent, { type: 'content_block_delta' }>): void => {
  if (!block) throw new Error(`Messages content block ${event.index} received a delta before its start event`);

  switch (event.delta.type) {
  case 'text_delta':
    if (block.type !== 'text') throw new Error(`Messages ${event.delta.type} cannot update a ${block.type} block`);
    block.text += requiredString(event.delta.text, 'Messages text_delta.text');
    block.citations.push(...normalizeMessagesTextCitations(event.delta.citations));
    return;
  case 'citations_delta': {
    if (block.type !== 'text') throw new Error(`Messages ${event.delta.type} cannot update a ${block.type} block`);
    block.citations.push(normalizeMessagesTextCitation(event.delta.citation));
    return;
  }
  case 'input_json_delta':
    if (block.type !== 'tool_use') throw new Error(`Messages ${event.delta.type} cannot update a ${block.type} block`);
    block.inputJson += requiredString(event.delta.partial_json, 'Messages input_json_delta.partial_json');
    return;
  case 'thinking_delta':
    if (block.type !== 'thinking') throw new Error(`Messages ${event.delta.type} cannot update a ${block.type} block`);
    block.thinking += requiredString(event.delta.thinking, 'Messages thinking_delta.thinking');
    return;
  case 'signature_delta':
    if (block.type !== 'thinking') throw new Error(`Messages ${event.delta.type} cannot update a ${block.type} block`);
    block.signature = requiredString(event.delta.signature, 'Messages signature_delta.signature');
    return;
  default:
    throw new TypeError(`Unsupported Messages content block delta type: ${(event.delta as { type?: unknown }).type as string}`);
  }
};

const finalizeToolUseInput = (block: MessagesBlockAccumulator | undefined): void => {
  if (block?.type !== 'tool_use' || !block.inputJson) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(block.inputJson) as unknown;
  } catch (cause) {
    throw new SyntaxError('Malformed upstream Messages tool input JSON', { cause });
  }
  if (!isJsonObject(parsed)) throw new TypeError('Upstream Messages tool input must be a JSON object');
  block.input = parsed;
};

const checkedBlockIndex = (index: number): number => {
  if (!Number.isSafeInteger(index) || index < 0) throw new RangeError(`Messages content block index must be a non-negative safe integer: ${index}`);
  return index;
};

const finalizeContentBlock = (block: MessagesBlockAccumulator): MessagesAssistantContentBlock => {
  const extras = block[BLOCK_EXTRAS];
  const withExtras = <T extends MessagesAssistantContentBlock>(b: T): T =>
    extras && Object.keys(extras).length > 0 ? ({ ...b, ...extras } as T) : b;

  switch (block.type) {
  case 'text': {
    const { citations, [BLOCK_EXTRAS]: _extras, ...textBlock } = block;
    return withExtras(citations.length > 0 ? ({ ...textBlock, citations } as MessagesAssistantContentBlock) : (textBlock as MessagesAssistantContentBlock));
  }
  case 'tool_use': {
    const { inputJson: _inputJson, [BLOCK_EXTRAS]: _extras, ...toolUseBlock } = block;
    return withExtras(toolUseBlock as MessagesAssistantContentBlock);
  }
  default: {
    const { [BLOCK_EXTRAS]: _extras, ...rest } = block;
    return withExtras(rest as MessagesAssistantContentBlock);
  }
  }
};

export async function reassembleMessagesEvents(events: AsyncIterable<MessagesStreamEvent>): Promise<MessagesResult> {
  let id = '';
  let model = '';
  const usage: MessagesResult['usage'] = {
    input_tokens: 0,
    output_tokens: 0,
  };
  let stopReason: MessagesResult['stop_reason'] = null;
  let stopDetails: MessagesRefusalStopDetails | null | undefined;
  let stopSequence: string | null = null;

  const blocks = new Map<number, MessagesBlockState>();
  const resultExtras: Record<string, unknown> = {};
  let messageStarted = false;
  let messageStopped = false;
  let terminalDeltaSeen = false;

  for await (const typedEvent of events) {
    if (!isJsonObject(typedEvent) || typeof typedEvent.type !== 'string' || typedEvent.type.length === 0) throw new TypeError('Messages stream event must be an object with a non-empty string type');
    const event = typedEvent as MessagesStreamEvent;
    if (messageStopped) throw new Error(`Messages stream emitted ${event.type} after message_stop`);
    if (terminalDeltaSeen && event.type !== 'message_stop' && event.type !== 'ping' && event.type !== 'error') {
      throw new Error(`Messages stream emitted ${event.type} after its terminal message_delta`);
    }
    switch (event.type) {
    case 'message_start':
      if (messageStarted) throw new Error('Messages stream emitted more than one message_start event');
      if (!isJsonObject(event.message)) throw new TypeError('Messages message_start.message must be an object');
      requiredNonEmptyString(event.message.id, 'Messages message id');
      requiredNonEmptyString(event.message.model, 'Messages message model');
      messageStarted = true;
      id = event.message.id;
      model = event.message.model;
      stopDetails = event.message.stop_details;
      applyMessagesUsage(usage, event.message.usage);
      captureExtras(event.message as unknown as Record<string, unknown>, KNOWN_MESSAGE_KEYS, resultExtras);
      break;
    case 'content_block_start':
      if (!messageStarted) throw new Error('Messages content block started before message_start');
      checkedBlockIndex(event.index);
      if (blocks.has(event.index)) throw new Error(`Messages content block ${event.index} started more than once`);
      if (!isJsonObject(event.content_block) || typeof event.content_block.type !== 'string') throw new TypeError('Messages content_block_start.content_block must be an object with a string type');
      blocks.set(event.index, { accumulator: createBlockAccumulator(event), stopped: false });
      break;
    case 'content_block_delta': {
      checkedBlockIndex(event.index);
      if (!isJsonObject(event.delta) || typeof event.delta.type !== 'string') throw new TypeError('Messages content_block_delta.delta must be an object with a string type');
      const state = blocks.get(event.index);
      if (state?.stopped) throw new Error(`Messages content block ${event.index} received a delta after its stop event`);
      applyBlockDelta(state?.accumulator, event);
      break;
    }
    case 'content_block_stop': {
      checkedBlockIndex(event.index);
      const state = blocks.get(event.index);
      if (!state) throw new Error(`Messages content block ${event.index} stopped before its start event`);
      if (state.stopped) throw new Error(`Messages content block ${event.index} stopped more than once`);
      finalizeToolUseInput(state.accumulator);
      state.stopped = true;
      break;
    }
    case 'message_delta':
      if (!messageStarted) throw new Error('Messages message_delta arrived before message_start');
      if (!isJsonObject(event.delta)) throw new TypeError('Messages message_delta.delta must be an object');
      if (event.delta.stop_reason !== undefined && event.delta.stop_reason !== null) {
        for (const [index, state] of blocks) {
          if (!state.stopped) throw new Error(`Messages content block ${index} remained open at terminal message_delta`);
        }
        terminalDeltaSeen = true;
      }
      if (event.delta.stop_reason != null) {
        stopReason = event.delta.stop_reason;
      }
      if ('stop_details' in event.delta) {
        stopDetails = event.delta.stop_details;
      }
      if ('stop_sequence' in event.delta) {
        stopSequence = event.delta.stop_sequence as string | null;
      }
      applyMessagesUsage(usage, event.usage);
      break;
    case 'error':
      throw new Error(`Upstream SSE error: ${event.error?.type ?? 'unknown'}: ${event.error?.message ?? JSON.stringify(event)}`);
    case 'message_stop':
      if (!messageStarted) throw new Error('Messages message_stop arrived before message_start');
      for (const [index, state] of blocks) {
        if (!state.stopped) throw new Error(`Messages content block ${index} remained open at message_stop`);
      }
      messageStopped = true;
      break;
    case 'ping':
      break;
    default:
      throw new TypeError(`Unsupported Messages stream event type: ${(event as { type?: unknown }).type as string}`);
    }
  }

  if (!messageStarted) throw new Error('Messages stream ended without a message_start event');
  if (!messageStopped) throw new Error('Messages stream ended without a message_stop event');
  const orderedBlocks = [...blocks.entries()].toSorted(([left], [right]) => left - right);
  for (let position = 0; position < orderedBlocks.length; position++) {
    if (orderedBlocks[position]![0] !== position) throw new Error(`Messages content block indexes must be contiguous from zero; missing index ${position}`);
  }
  const content = orderedBlocks.map(([, state]) => finalizeContentBlock(state.accumulator));

  return {
    id,
    type: 'message',
    role: 'assistant',
    content,
    model,
    stop_reason: stopReason,
    ...(stopDetails !== undefined ? { stop_details: stopDetails } : {}),
    stop_sequence: stopSequence,
    usage,
    ...resultExtras,
  } as MessagesResult;
}
