import { unwrapCustomToolInput } from '../shared/responses-via/custom-tool-wrap.ts';
import * as responses from '../shared/responses-via/responses-event-builder.ts';
import { eventFrame, USAGE_BILLING, type ProtocolFrame } from '@floway-dev/protocols/common';
import {
  mergeMessagesUsageSnapshot,
  messagesUsageSnapshot,
  splitMessagesCacheCreationTokens,
} from '@floway-dev/protocols/messages';
import type {
  MessagesContentBlockDeltaEvent,
  MessagesContentBlockStartEvent,
  MessagesContentBlockStopEvent,
  MessagesMessageDeltaEvent,
  MessagesMessageStartEvent,
  MessagesStreamEvent,
  MessagesTextCitation,
  MessagesUsageSnapshot,
} from '@floway-dev/protocols/messages';
import { createRandomResponsesItemId, type ResponsesOutputItem, type ResponsesResult, type ResponsesStreamEvent } from '@floway-dev/protocols/responses';

const UPSTREAM_MESSAGES_MISSING_TERMINAL_MESSAGE = 'Upstream Messages stream ended without a message_stop event.';

const upstreamMessagesEventsUntilTerminal = async function* (frames: AsyncIterable<ProtocolFrame<MessagesStreamEvent>>): AsyncGenerator<MessagesStreamEvent> {
  for await (const frame of frames) {
    if (frame.type === 'done') continue;

    yield frame.event;
    if (frame.event.type === 'message_stop' || frame.event.type === 'error') {
      return;
    }
  }

  throw new Error(UPSTREAM_MESSAGES_MISSING_TERMINAL_MESSAGE);
};

type OutputBlockInfo =
  | {
    type: 'thinking';
    outputIndex: number;
    itemId: string;
    thinkingText: string;
    // Genuine upstream reasoning signature, captured from `signature_delta`.
    // Carried verbatim as the Responses item's `encrypted_content` so it
    // round-trips back to the Messages upstream's next-turn validation.
    encryptedContent?: string;
  }
  | {
    type: 'text';
    outputIndex: number;
    itemId: string;
    blockText: string;
    // Monotonic counter of url_citation annotations for this text
    // content part. The Responses protocol requires per-content-part
    // ordering and Responses targets always use content_index=0 for our
    // single-part assistant message, so one counter per text block
    // matches the spec.
    annotationIndex: number;
  }
  | {
    type: 'tool_use';
    outputIndex: number;
    itemId: string;
    toolCallId: string;
    toolName: string;
    toolArguments: string;
  }
  | {
    type: 'custom_tool_use';
    outputIndex: number;
    itemId: string;
    toolCallId: string;
    toolName: string;
    wrappedArguments: string;
  };

interface MessagesToResponsesStreamState {
  responseId: string;
  model: string;
  outputIndex: number;
  sequenceNumber: number;
  blockMap: Map<number, OutputBlockInfo>;
  accumulatedText: string;
  completedItems: ResponsesOutputItem[];
  usage: MessagesUsageSnapshot;
  stopReason?: MessagesMessageDeltaEvent['delta']['stop_reason'];
  customToolNames: ReadonlySet<string>;
}

const buildResult = (state: MessagesToResponsesStreamState, status: ResponsesResult['status']): ResponsesResult => {
  const { cacheWrite, cacheWrite1h } = splitMessagesCacheCreationTokens(state.usage);
  const cacheRead = state.usage.cache_read_input_tokens ?? 0;
  const cacheCreation = cacheWrite + cacheWrite1h;
  const hasCacheCreation = state.usage.cache_creation_input_tokens !== undefined
    || state.usage.cache_creation?.ephemeral_5m_input_tokens !== undefined
    || state.usage.cache_creation?.ephemeral_1h_input_tokens !== undefined;
  const inputTokens = (state.usage.input_tokens ?? 0) + cacheRead + cacheCreation;
  // Anthropic's `speed: 'fast'` surfaces as OpenAI `service_tier: 'fast'`;
  // all other Anthropic service_tier values pass through directly.
  const serviceTier = state.usage.speed === 'fast' ? 'fast' : state.usage.service_tier;

  return responses.result({
    id: state.responseId,
    model: state.model,
    output: state.completedItems,
    outputText: state.accumulatedText,
    status,
    // Messages signals "ran out of tokens" with `stop_reason: 'max_tokens'`,
    // which the caller maps to `status === 'incomplete'` (see
    // `handleMessageStop` in this file). Other Anthropic stop_reasons
    // don't map to incomplete.
    ...(status === 'incomplete' ? { incompleteDetails: { reason: 'max_output_tokens' as const } } : {}),
    usage: {
      input_tokens: inputTokens,
      output_tokens: state.usage.output_tokens,
      total_tokens: inputTokens + state.usage.output_tokens,
      ...(state.usage.cache_read_input_tokens !== undefined || hasCacheCreation
        ? {
            input_tokens_details: {
              cached_tokens: state.usage.cache_read_input_tokens ?? 0,
              ...(hasCacheCreation ? { cache_write_tokens: cacheCreation } : {}),
            },
          }
        : {}),
      ...(cacheWrite1h > 0 ? { [USAGE_BILLING]: { cacheWrite1hTokenCount: cacheWrite1h } } : {}),
    },
    ...(serviceTier !== undefined ? { serviceTier } : {}),
  });
};

const handleMessageStart = (event: MessagesMessageStartEvent, state: MessagesToResponsesStreamState): ResponsesStreamEvent[] => {
  state.usage = messagesUsageSnapshot(event.message.usage);

  const response = buildResult(state, 'in_progress');

  return responses.started(state, response);
};

const handleContentBlockStart = (event: MessagesContentBlockStartEvent, state: MessagesToResponsesStreamState): ResponsesStreamEvent[] => {
  switch (event.content_block.type) {
  case 'thinking': {
    const outputIndex = state.outputIndex++;
    const itemId = createRandomResponsesItemId('reasoning');
    state.blockMap.set(event.index, {
      type: 'thinking',
      outputIndex,
      itemId,
      thinkingText: '',
    });

    return responses.reasoningStart(state, outputIndex, itemId);
  }
  case 'redacted_thinking': {
    // A redacted upstream reasoning block carries an opaque signature in
    // `data` and no readable text. Surface it as a Responses reasoning item
    // whose `encrypted_content` round-trips that opaque blob.
    const outputIndex = state.outputIndex++;
    const itemId = createRandomResponsesItemId('reasoning');
    state.blockMap.set(event.index, {
      type: 'thinking',
      outputIndex,
      itemId,
      thinkingText: '',
      encryptedContent: event.content_block.data,
    });

    return responses.reasoningStart(state, outputIndex, itemId);
  }
  case 'text': {
    const outputIndex = state.outputIndex++;
    const itemId = createRandomResponsesItemId('message');
    state.blockMap.set(event.index, {
      type: 'text',
      outputIndex,
      itemId,
      blockText: '',
      annotationIndex: 0,
    });

    return responses.textStart(state, outputIndex, itemId);
  }
  case 'tool_use': {
    const outputIndex = state.outputIndex++;
    if (state.customToolNames.has(event.content_block.name)) {
      const itemId = createRandomResponsesItemId('custom_tool_call');
      state.blockMap.set(event.index, {
        type: 'custom_tool_use',
        outputIndex,
        itemId,
        toolCallId: event.content_block.id,
        toolName: event.content_block.name,
        wrappedArguments: '',
      });

      return responses.itemAdded(state, outputIndex, responses.customToolCallItem(itemId, event.content_block.id, event.content_block.name, ''));
    }

    const itemId = createRandomResponsesItemId('function_call');
    const info: OutputBlockInfo = {
      type: 'tool_use',
      outputIndex,
      itemId,
      toolCallId: event.content_block.id,
      toolName: event.content_block.name,
      toolArguments: '',
    };
    state.blockMap.set(event.index, info);

    return responses.itemAdded(state, outputIndex, responses.functionCallItem(info.itemId, info.toolCallId, info.toolName, info.toolArguments, 'in_progress'));
  }
  default:
    return [];
  }
};

// Anthropic emits `citations_delta` against a text content block when the
// model cites a structured `search_result` / `web_search_result` tool
// result. We surface these as Responses
// `response.output_text.annotation.added` events with inline
// `url_citation` annotations.
//
// Offset approximation: Anthropic gives `start_block_index` /
// `end_block_index` referring to indices inside our
// `MessagesSearchResultBlock.content` (the cited source's text, not the
// model's reply). Responses url_citation indices are character offsets
// inside the model's reply. We approximate using cited_text length:
// `end_index = blockText.length` (running char count emitted so far on
// this content part), `start_index = max(0, end_index - cited_text.length)`.
// Citation deltas without `cited_text` are dropped — we have no way to
// anchor them. The chat-completions-via-messages translator
// blanket-drops every `citations_delta` because Chat Completions has no
// url_citation equivalent.
const handleTextCitation = (info: Extract<OutputBlockInfo, { type: 'text' }>, citation: MessagesTextCitation, state: MessagesToResponsesStreamState): ResponsesStreamEvent[] => {
  // Future citation variants (`char_location`, `page_location`,
  // `content_block_location` from Anthropic native long-document
  // citations) are not in the current `MessagesTextCitation` union; if
  // they're added, this branch needs to either skip or map them.
  if (citation.type !== 'search_result_location' && citation.type !== 'web_search_result_location') {
    return [];
  }

  if (!citation.cited_text) {
    // A present cited_text on an empty blockText (citation arriving
    // BEFORE any text_delta on this block) yields end_index=0,
    // start_index=0; in practice Anthropic emits citation deltas after
    // the triggering text chunk so this corner is unreachable.
    return [];
  }

  const endIndex = info.blockText.length;
  const startIndex = Math.max(0, endIndex - citation.cited_text.length);
  const annotationIndex = info.annotationIndex++;

  return responses.seq(state, [
    {
      type: 'response.output_text.annotation.added',
      output_index: info.outputIndex,
      content_index: 0,
      item_id: info.itemId,
      annotation_index: annotationIndex,
      annotation: {
        type: 'url_citation',
        url: citation.url,
        title: citation.title,
        start_index: startIndex,
        end_index: endIndex,
      },
    },
  ]);
};

const handleContentBlockDelta = (event: MessagesContentBlockDeltaEvent, state: MessagesToResponsesStreamState): ResponsesStreamEvent[] => {
  const info = state.blockMap.get(event.index);
  if (!info) return [];

  switch (info.type) {
  case 'thinking':
    if (event.delta.type === 'thinking_delta') {
      info.thinkingText += event.delta.thinking;
      return responses.reasoningDelta(state, info.outputIndex, info.itemId, event.delta.thinking);
    }
    if (event.delta.type === 'signature_delta') {
      // The upstream owns this signature; carry it verbatim as the Responses
      // item's `encrypted_content` (no gateway envelope) so the next turn's
      // upstream validation still passes.
      info.encryptedContent = event.delta.signature;
    }
    return [];
  case 'text':
    if (event.delta.type === 'citations_delta') {
      return handleTextCitation(info, event.delta.citation, state);
    }
    if (event.delta.type !== 'text_delta') return [];
    info.blockText += event.delta.text;
    state.accumulatedText += event.delta.text;
    return responses.textDelta(state, info.outputIndex, info.itemId, event.delta.text);
  case 'tool_use':
    if (event.delta.type !== 'input_json_delta') return [];
    info.toolArguments += event.delta.partial_json;
    return responses.argumentsDelta(state, info.outputIndex, info.itemId, event.delta.partial_json);
  case 'custom_tool_use':
    // Buffer the wrapped JSON argument blob without emitting a delta; we need
    // the complete value to extract the freeform `input` field at stop time.
    if (event.delta.type === 'input_json_delta') {
      info.wrappedArguments += event.delta.partial_json;
    }
    return [];
  }
};

const handleContentBlockStop = (event: MessagesContentBlockStopEvent, state: MessagesToResponsesStreamState): ResponsesStreamEvent[] => {
  const info = state.blockMap.get(event.index);
  if (!info) return [];

  state.blockMap.delete(event.index);

  if (info.type === 'thinking') {
    const summaryText = info.thinkingText;
    const itemId = info.itemId;
    const item = responses.reasoningItem(itemId, summaryText, info.encryptedContent);

    state.completedItems.push(item);

    return responses.reasoningDone(state, info.outputIndex, itemId, summaryText, item);
  }

  if (info.type === 'text') {
    const item = responses.messageItem(info.itemId, info.blockText);

    state.completedItems.push(item);

    return responses.textDone(state, info.outputIndex, info.itemId, info.blockText, item);
  }

  if (info.type === 'custom_tool_use') {
    const input = unwrapCustomToolInput(info.wrappedArguments);
    const item = responses.customToolCallItem(info.itemId, info.toolCallId, info.toolName, input);

    state.completedItems.push(item);

    return responses.customToolCallDone(state, info.outputIndex, info.itemId, input, item);
  }

  const item = responses.functionCallItem(info.itemId, info.toolCallId, info.toolName, info.toolArguments, 'completed');

  state.completedItems.push(item);

  return responses.functionCallDone(state, info.outputIndex, info.itemId, info.toolArguments, item);
};

export const createMessagesToResponsesStreamState = (responseId: string, model: string, customToolNames: ReadonlySet<string> = new Set()): MessagesToResponsesStreamState => ({
  responseId,
  model,
  outputIndex: 0,
  sequenceNumber: 0,
  blockMap: new Map(),
  accumulatedText: '',
  completedItems: [],
  usage: messagesUsageSnapshot(),
  customToolNames,
});

export const translateMessagesEventToResponsesEvents = (event: MessagesStreamEvent, state: MessagesToResponsesStreamState): ResponsesStreamEvent[] => {
  switch (event.type) {
  case 'message_start':
    return handleMessageStart(event, state);
  case 'content_block_start':
    return handleContentBlockStart(event, state);
  case 'content_block_delta':
    return handleContentBlockDelta(event, state);
  case 'content_block_stop':
    return handleContentBlockStop(event, state);
  case 'message_delta': {
    if (event.delta.stop_reason !== undefined) {
      state.stopReason = event.delta.stop_reason;
    }
    if (event.usage) {
      state.usage = mergeMessagesUsageSnapshot(state.usage, event.usage);
    }
    return [];
  }
  case 'message_stop': {
    const status: ResponsesResult['status'] = state.stopReason === 'max_tokens' ? 'incomplete' : 'completed';
    const response = buildResult(state, status);

    return responses.terminal(state, response);
  }
  case 'ping':
    return responses.seq(state, [{ type: 'ping' }]);
  case 'error':
    return responses.seq(state, [
      {
        type: 'error',
        message: event.error.message,
        code: event.error.type,
      },
    ]);
  }
};

export const translateToSourceEvents = async function* (
  frames: AsyncIterable<ProtocolFrame<MessagesStreamEvent>>,
  responseId: string,
  model: string,
  customToolNames: ReadonlySet<string> = new Set(),
): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {
  const state = createMessagesToResponsesStreamState(responseId, model, customToolNames);

  for await (const event of upstreamMessagesEventsUntilTerminal(frames)) {
    for (const translated of translateMessagesEventToResponsesEvents(event, state)) {
      yield eventFrame(translated);
    }
  }
};
