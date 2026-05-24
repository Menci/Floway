import { isJsonObject } from '../../../../../shared/json-helpers.ts';
import type {
  MessagesAssistantContentBlock,
  MessagesRedactedThinkingBlock,
  MessagesResponse,
  MessagesServerToolUseBlock,
  MessagesStreamEventData,
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

type TextBlockAccumulator = {
  type: 'text';
  text: string;
  citations: MessagesTextCitation[];
};

type ToolUseBlockAccumulator = MessagesToolUseBlock & {
  inputJson: string;
};

type BlockAccumulator = TextBlockAccumulator | ToolUseBlockAccumulator | MessagesServerToolUseBlock | MessagesWebSearchToolResultBlock | MessagesThinkingBlock | MessagesRedactedThinkingBlock;

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
  if (update.service_tier != null) usage.service_tier = update.service_tier;
  if (update.server_tool_use != null) {
    usage.server_tool_use = update.server_tool_use;
  }
};

const createBlockAccumulator = (event: Extract<MessagesStreamEventData, { type: 'content_block_start' }>): BlockAccumulator => {
  const block = event.content_block;

  switch (block.type) {
  case 'text':
    return {
      type: 'text',
      text: block.text ?? '',
      citations: normalizeMessagesTextCitations(block.citations),
    };
  case 'tool_use':
    return {
      type: 'tool_use',
      id: block.id,
      name: block.name,
      input: {},
      inputJson: '',
    };
  case 'server_tool_use':
    return {
      type: 'server_tool_use',
      id: block.id,
      name: block.name,
      input: block.input,
    };
  case 'web_search_tool_result':
    return {
      type: 'web_search_tool_result',
      tool_use_id: block.tool_use_id,
      content: block.content,
    };
  case 'thinking':
    return { type: 'thinking', thinking: block.thinking ?? '' };
  case 'redacted_thinking':
    return { type: 'redacted_thinking', data: block.data };
  }
};

const applyBlockDelta = (block: BlockAccumulator | undefined, event: Extract<MessagesStreamEventData, { type: 'content_block_delta' }>): void => {
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
    block.signature = `${block.signature ?? ''}${event.delta.signature ?? ''}`;
    return;
  }
};

const finalizeToolUseInput = (block: BlockAccumulator | undefined): void => {
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

const finalizeContentBlock = (block: BlockAccumulator): MessagesAssistantContentBlock => {
  switch (block.type) {
  case 'text': {
    const { citations, ...textBlock } = block;
    return citations.length > 0 ? block : textBlock;
  }
  case 'tool_use': {
    const { inputJson: _inputJson, ...toolUseBlock } = block;
    return toolUseBlock;
  }
  default:
    return block;
  }
};

export async function reassembleMessagesEvents(events: AsyncIterable<MessagesStreamEventData>): Promise<MessagesResponse> {
  let id = '';
  let model = '';
  const usage: MessagesResponse['usage'] = {
    input_tokens: 0,
    output_tokens: 0,
  };
  let stopReason: MessagesResponse['stop_reason'] = null;
  let stopSequence: string | null = null;

  const blocks: Array<BlockAccumulator | undefined> = [];

  for await (const event of events) {
    switch (event.type) {
    case 'message_start':
      id = event.message.id;
      model = event.message.model;
      applyMessagesUsage(usage, event.message.usage);
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
  };
}
