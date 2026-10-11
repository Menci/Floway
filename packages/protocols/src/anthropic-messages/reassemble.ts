import type {
  AnthropicMessagesAssistantContentBlock,
  AnthropicMessagesRefusalStopDetails,
  AnthropicMessagesResult,
  AnthropicMessagesStreamEventEx,
  AnthropicMessagesTextCitation,
  AnthropicMessagesUsage,
  AnthropicMessagesUsageDelta,
} from './index.ts';
import { cloneAnthropicMessagesUsageIterations, splitAnthropicMessagesCacheCreationTokens, usageDeltaKeys } from './usage.ts';
import { captureExtras } from '../common/reassemble-extras.ts';

const normalizeAnthropicMessagesTextCitations = (value: AnthropicMessagesTextCitation[] | null | undefined): AnthropicMessagesTextCitation[] => value == null ? [] : [...value];

type AnthropicMessagesTextBlockAccumulator = {
  type: 'text';
  text: string;
  citations: AnthropicMessagesTextCitation[];
};

type AnthropicMessagesToolUseBlockAccumulator = Extract<AnthropicMessagesAssistantContentBlock, { type: 'tool_use' | 'server_tool_use' }> & { inputJson: string };
type AnthropicMessagesBlockAccumulator = (AnthropicMessagesTextBlockAccumulator | AnthropicMessagesToolUseBlockAccumulator | Exclude<AnthropicMessagesAssistantContentBlock, { type: 'text' | 'tool_use' | 'server_tool_use' }>) & { extras?: Record<string, unknown> };

// Field-fidelity contract — see {@link captureExtras}. Anything an upstream
// emits on `message_start.message`, on a `content_block`, or on the assembled
// result top-level beyond the typed schema below survives by default.
const KNOWN_MESSAGE_KEYS = new Set(['id', 'type', 'role', 'content', 'model', 'stop_reason', 'stop_details', 'stop_sequence', 'usage']);
const KNOWN_BLOCK_KEYS_BY_TYPE: Record<string, ReadonlySet<string>> = {
  text: new Set(['type', 'text', 'citations']),
  tool_use: new Set(['type', 'id', 'name', 'input']),
  thinking: new Set(['type', 'thinking', 'signature']),
  redacted_thinking: new Set(['type', 'data']),
  compaction: new Set(['type', 'content', 'encrypted_content']),
  server_tool_use: new Set(['type', 'id', 'name', 'input']),
  web_search_tool_result: new Set(['type', 'tool_use_id', 'content']),
  fallback: new Set(['type', 'from', 'to', 'trigger']),
};
const FALLBACK_BLOCK_KNOWN = new Set(['type']);

const applyAnthropicMessagesUsageDelta = (usage: AnthropicMessagesUsage, update: AnthropicMessagesUsageDelta | undefined): void => {
  if (!update) return;
  for (const key of usageDeltaKeys) {
    const value = update[key];
    if (value != null) Object.defineProperty(usage, key, {
      value: key === 'iterations' ? cloneAnthropicMessagesUsageIterations(update.iterations!) : value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
};

const createBlockAccumulator = (event: Extract<AnthropicMessagesStreamEventEx, { type: 'content_block_start' }>): AnthropicMessagesBlockAccumulator => {
  const block = event.content_block;
  const rawBlock = block as unknown as Record<string, unknown>;
  const knownKeys = KNOWN_BLOCK_KEYS_BY_TYPE[block.type] ?? FALLBACK_BLOCK_KNOWN;
  const extras: Record<string, unknown> = {};
  captureExtras(rawBlock, knownKeys, extras);
  const withExtras = <T extends AnthropicMessagesBlockAccumulator>(acc: T): T =>
    Object.keys(extras).length > 0 ? Object.assign(acc, { extras }) : acc;

  if (block.type === 'text') return withExtras({ type: 'text', text: block.text, citations: normalizeAnthropicMessagesTextCitations(block.citations) });
  if (block.type === 'tool_use' || block.type === 'server_tool_use') return withExtras({ ...block, inputJson: '' });
  return withExtras({ ...block });
};

const applyBlockDelta = (block: AnthropicMessagesBlockAccumulator | undefined, event: Extract<AnthropicMessagesStreamEventEx, { type: 'content_block_delta' }>): void => {
  if (!block) return;

  switch (event.delta.type) {
  case 'text_delta':
    if (block.type !== 'text') return;
    block.text += event.delta.text ?? '';
    return;
  case 'citations_delta': {
    if (block.type !== 'text') return;
    block.citations.push(event.delta.citation);
    return;
  }
  case 'input_json_delta':
    if (block.type !== 'tool_use' && block.type !== 'server_tool_use') return;
    block.inputJson += event.delta.partial_json ?? '';
    return;
  case 'thinking_delta':
    if (block.type !== 'thinking') return;
    block.thinking += event.delta.thinking ?? '';
    return;
  case 'compaction_delta':
    if (block.type !== 'compaction') return;
    block.content = event.delta.content;
    if (event.delta.encrypted_content !== undefined) block.encrypted_content = event.delta.encrypted_content;
    return;
  case 'signature_delta':
    if (block.type !== 'thinking') return;
    block.signature = event.delta.signature;
    return;
  }
};

const finalizeToolUseInput = (block: AnthropicMessagesBlockAccumulator | undefined): void => {
  if ((block?.type !== 'tool_use' && block?.type !== 'server_tool_use') || !block.inputJson) return;

  block.input = JSON.parse(block.inputJson);
};

const finalizeContentBlock = (block: AnthropicMessagesBlockAccumulator): AnthropicMessagesAssistantContentBlock => {
  const extras = block.extras;
  const withExtras = <T extends AnthropicMessagesAssistantContentBlock>(b: T): T =>
    extras && Object.keys(extras).length > 0 ? ({ ...b, ...extras } as T) : b;

  switch (block.type) {
  case 'text': {
    const { citations, extras: _extras, ...textBlock } = block;
    return withExtras({ ...textBlock, citations: citations.length > 0 ? citations : null } as AnthropicMessagesAssistantContentBlock);
  }
  case 'tool_use':
  case 'server_tool_use': {
    const { inputJson: _inputJson, extras: _extras, ...toolUseBlock } = block;
    return withExtras(toolUseBlock as AnthropicMessagesAssistantContentBlock);
  }
  default: {
    const { extras: _extras, ...rest } = block;
    return withExtras(rest as AnthropicMessagesAssistantContentBlock);
  }
  }
};

export async function reassembleAnthropicMessagesEvents(events: AsyncIterable<AnthropicMessagesStreamEventEx>): Promise<AnthropicMessagesResult> {
  let id = '';
  let model = '';
  let usage: AnthropicMessagesUsage | undefined;

  let stopReason: AnthropicMessagesResult['stop_reason'] = null;
  let stopDetails: AnthropicMessagesRefusalStopDetails | null = null;
  let stopSequence: string | null = null;

  const blocks: Array<AnthropicMessagesBlockAccumulator | undefined> = [];
  const resultExtras: Record<string, unknown> = {};

  for await (const event of events) {
    switch (event.type) {
    case 'message_start':
      id = event.message.id;
      model = event.message.model;
      stopDetails = event.message.stop_details;
      usage = { ...event.message.usage };
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
      if ('stop_details' in event.delta) {
        stopDetails = event.delta.stop_details;
      }
      if ('stop_sequence' in event.delta) {
        stopSequence = event.delta.stop_sequence as string | null;
      }
      if (usage === undefined) throw new Error('Messages message_delta arrived before message_start');
      applyAnthropicMessagesUsageDelta(usage, event.usage);
      if (event.usage.cache_creation !== undefined) {
        if (event.usage.cache_creation === null) usage.cache_creation = null;
        else {
          const tokens = splitAnthropicMessagesCacheCreationTokens({ cache_creation: event.usage.cache_creation, ...(usage.cache_creation_input_tokens === null ? {} : { cache_creation_input_tokens: usage.cache_creation_input_tokens }) });
          usage.cache_creation = { ephemeral_5m_input_tokens: tokens.cacheWrite, ephemeral_1h_input_tokens: tokens.cacheWrite1h };
        }
      }
      if (event.usage.service_tier != null) usage.service_tier = event.usage.service_tier;
      if (event.usage.speed != null) usage.speed = event.usage.speed;
      if (event.usage.inference_geo != null) usage.inference_geo = event.usage.inference_geo;
      break;
    case 'error':
      throw new Error(`Upstream SSE error: ${event.error?.type ?? 'unknown'}: ${event.error?.message ?? JSON.stringify(event)}`);
    case 'message_stop':
    case 'ping':
      break;
    }
  }

  if (usage === undefined) throw new Error('Messages stream ended without message_start');
  const content = blocks.flatMap((block): AnthropicMessagesAssistantContentBlock[] => (block ? [finalizeContentBlock(block)] : []));

  return {
    id,
    type: 'message',
    role: 'assistant',
    content,
    model,
    stop_reason: stopReason,
    stop_details: stopDetails,
    container: null,
    diagnostics: null,
    stop_sequence: stopSequence,
    usage,
    ...resultExtras,
  } as AnthropicMessagesResult;
}
