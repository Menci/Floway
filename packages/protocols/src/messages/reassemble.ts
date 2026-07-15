import { isJsonObject } from '../common/json.ts';
import { captureExtras } from '../common/reassemble-extras.ts';
import type {
  MessagesAssistantContentBlock,
  MessagesRedactedThinkingBlock,
  MessagesResult,
  MessagesServerToolUseBlock,
  MessagesStreamEvent,
  MessagesTextCitation,
  MessagesThinkingBlock,
  MessagesToolUseBlock,
  MessagesUsage,
  MessagesWebSearchToolResultBlock,
} from '@floway-dev/protocols/messages';

const normalizeMessagesTextCitation = (value: unknown): MessagesTextCitation | null => {
  if (!isJsonObject(value) || typeof value.type !== 'string') {
    return null;
  }

  if (value.type === 'search_result_location') {
    const url = typeof value.url === 'string' ? value.url : typeof value.source === 'string' ? value.source : null;

    if (!url || typeof value.title !== 'string' || !Number.isInteger(value.search_result_index) || !Number.isInteger(value.start_block_index) || !Number.isInteger(value.end_block_index)) {
      return null;
    }

    return {
      type: 'search_result_location',
      url,
      title: value.title,
      search_result_index: value.search_result_index as number,
      start_block_index: value.start_block_index as number,
      end_block_index: value.end_block_index as number,
      ...(typeof value.cited_text === 'string' ? { cited_text: value.cited_text } : {}),
    };
  }

  if (value.type === 'web_search_result_location') {
    const url = typeof value.url === 'string' ? value.url : typeof value.source === 'string' ? value.source : null;

    if (!url || typeof value.title !== 'string' || typeof value.encrypted_index !== 'string') {
      return null;
    }

    return {
      type: 'web_search_result_location',
      url,
      title: value.title,
      encrypted_index: value.encrypted_index,
      ...(typeof value.cited_text === 'string' ? { cited_text: value.cited_text } : {}),
    };
  }

  return null;
};

const normalizeMessagesTextCitations = (value: unknown): MessagesTextCitation[] =>
  Array.isArray(value)
    ? value.flatMap(citation => {
        const normalized = normalizeMessagesTextCitation(citation);
        return normalized ? [normalized] : [];
      })
    : [];

type MessagesTextBlockAccumulator = {
  type: 'text';
  text: string;
  citations: MessagesTextCitation[];
};

type MessagesToolUseBlockAccumulator = MessagesToolUseBlock & {
  inputJson: string;
};

type MessagesBlockAccumulator = (MessagesTextBlockAccumulator | MessagesToolUseBlockAccumulator | MessagesServerToolUseBlock | MessagesWebSearchToolResultBlock | MessagesThinkingBlock | MessagesRedactedThinkingBlock) & { extras?: Record<string, unknown> };

// Field-fidelity contract — see {@link captureExtras}. Anything an upstream
// emits on `message_start.message`, on a `content_block`, or on the assembled
// result top-level beyond the typed schema below survives by default.
const KNOWN_MESSAGE_KEYS = new Set(['id', 'type', 'role', 'content', 'model', 'stop_reason', 'stop_sequence', 'usage']);
const KNOWN_BLOCK_KEYS_BY_TYPE: Record<string, ReadonlySet<string>> = {
  text: new Set(['type', 'text', 'citations']),
  tool_use: new Set(['type', 'id', 'name', 'input']),
  thinking: new Set(['type', 'thinking', 'signature']),
  redacted_thinking: new Set(['type', 'data']),
  server_tool_use: new Set(['type', 'id', 'name', 'input']),
  web_search_tool_result: new Set(['type', 'tool_use_id', 'content']),
};
const FALLBACK_BLOCK_KNOWN = new Set(['type']);

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
  if (update.cache_creation != null) usage.cache_creation = update.cache_creation;
  if (update.service_tier != null) usage.service_tier = update.service_tier;
  if (update.speed != null) usage.speed = update.speed;
  if (update.server_tool_use != null) {
    usage.server_tool_use = update.server_tool_use;
  }
};

const createBlockAccumulator = (event: Extract<MessagesStreamEvent, { type: 'content_block_start' }>): MessagesBlockAccumulator => {
  const block = event.content_block;
  const rawBlock = block as unknown as Record<string, unknown>;
  const knownKeys = KNOWN_BLOCK_KEYS_BY_TYPE[block.type] ?? FALLBACK_BLOCK_KNOWN;
  const extras: Record<string, unknown> = {};
  captureExtras(rawBlock, knownKeys, extras);
  const withExtras = <T extends MessagesBlockAccumulator>(acc: T): T =>
    Object.keys(extras).length > 0 ? Object.assign(acc, { extras }) : acc;

  switch (block.type) {
  case 'text':
    return withExtras({
      type: 'text',
      text: block.text ?? '',
      citations: normalizeMessagesTextCitations(block.citations),
    });
  case 'tool_use':
    return withExtras({
      type: 'tool_use',
      id: block.id,
      name: block.name,
      input: {},
      inputJson: '',
    });
  case 'server_tool_use':
    return withExtras({
      type: 'server_tool_use',
      id: block.id,
      name: block.name,
      input: block.input,
    });
  case 'web_search_tool_result':
    return withExtras({
      type: 'web_search_tool_result',
      tool_use_id: block.tool_use_id,
      content: block.content,
    });
  case 'thinking':
    return withExtras({ type: 'thinking', thinking: block.thinking ?? '' });
  case 'redacted_thinking':
    return withExtras({ type: 'redacted_thinking', data: block.data });
  }
};

const applyBlockDelta = (block: MessagesBlockAccumulator | undefined, event: Extract<MessagesStreamEvent, { type: 'content_block_delta' }>): void => {
  if (!block) return;

  switch (event.delta.type) {
  case 'text_delta':
    if (block.type !== 'text') return;
    block.text += event.delta.text ?? '';
    block.citations.push(...normalizeMessagesTextCitations(event.delta.citations));
    return;
  case 'citations_delta': {
    if (block.type !== 'text') return;
    const citation = normalizeMessagesTextCitation(event.delta.citation);
    if (citation) block.citations.push(citation);
    return;
  }
  case 'input_json_delta':
    if (block.type !== 'tool_use') return;
    block.inputJson += event.delta.partial_json ?? '';
    return;
  case 'thinking_delta':
    if (block.type !== 'thinking') return;
    block.thinking += event.delta.thinking ?? '';
    return;
  case 'signature_delta':
    if (block.type !== 'thinking') return;
    block.signature = event.delta.signature;
    return;
  }
};

const finalizeToolUseInput = (block: MessagesBlockAccumulator | undefined): void => {
  if (block?.type !== 'tool_use' || !block.inputJson) return;

  try {
    block.input = JSON.parse(block.inputJson);
  } catch {
    // Anthropic Messages requires `input` to be an object even when the
    // upstream streamed malformed JSON for a tool call. Failing the whole
    // response on a partial/garbage tool_use is more hostile to clients than
    // surfacing an empty object; the broken arguments stay observable via
    // the original SSE frames.
    block.input = {};
  }
};

const finalizeContentBlock = (block: MessagesBlockAccumulator): MessagesAssistantContentBlock => {
  const extras = block.extras;
  const withExtras = <T extends MessagesAssistantContentBlock>(b: T): T =>
    extras && Object.keys(extras).length > 0 ? ({ ...b, ...extras } as T) : b;

  switch (block.type) {
  case 'text': {
    const { citations, extras: _extras, ...textBlock } = block;
    return withExtras(citations.length > 0 ? ({ ...textBlock, citations } as MessagesAssistantContentBlock) : (textBlock as MessagesAssistantContentBlock));
  }
  case 'tool_use': {
    const { inputJson: _inputJson, extras: _extras, ...toolUseBlock } = block;
    return withExtras(toolUseBlock as MessagesAssistantContentBlock);
  }
  default: {
    const { extras: _extras, ...rest } = block;
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
  let stopSequence: string | null = null;

  const blocks: Array<MessagesBlockAccumulator | undefined> = [];
  const resultExtras: Record<string, unknown> = {};

  for await (const event of events) {
    switch (event.type) {
    case 'message_start':
      id = event.message.id;
      model = event.message.model;
      applyMessagesUsage(usage, event.message.usage);
      captureExtras(event.message as unknown as Record<string, unknown>, KNOWN_MESSAGE_KEYS, resultExtras);
      break;
    case 'content_block_start':
      blocks[event.index] = createBlockAccumulator(event);
      break;
    case 'content_block_delta':
      applyBlockDelta(blocks[event.index], event);
      break;
    case 'content_block_stop':
      finalizeToolUseInput(blocks[event.index]);
      break;
    case 'message_delta':
      if (event.delta.stop_reason != null) {
        stopReason = event.delta.stop_reason;
      }
      if ('stop_sequence' in event.delta) {
        stopSequence = event.delta.stop_sequence as string | null;
      }
      applyMessagesUsage(usage, event.usage);
      break;
    case 'error':
      throw new Error(`Upstream SSE error: ${event.error?.type ?? 'unknown'}: ${event.error?.message ?? JSON.stringify(event)}`);
    case 'message_stop':
    case 'ping':
      break;
    }
  }

  const content = blocks.flatMap((block): MessagesAssistantContentBlock[] => (block ? [finalizeContentBlock(block)] : []));

  return {
    id,
    type: 'message',
    role: 'assistant',
    content,
    model,
    stop_reason: stopReason,
    stop_sequence: stopSequence,
    usage,
    ...resultExtras,
  } as MessagesResult;
}
