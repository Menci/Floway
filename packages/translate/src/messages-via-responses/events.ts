import { isContextExceededError, PROMPT_TOO_LONG_MESSAGE } from '../shared/messages/context-window-error.ts';
import { packReasoningSignature } from '../shared/messages-and-responses/reasoning.ts';
import { createResponsesOutputOrderState, recordResponsesOutputOrderEvent, type ResponsesOutputOrderState, shouldDeferForEarlierResponsesOutput } from '../shared/via-responses/responses-stream-order.ts';
import { type ResponsesEvent, responsesPartKey } from '../shared/via-responses/responses-stream.ts';
import { eventFrame, splitCacheWriteTokens, splitInclusiveInputTokens, USAGE_BILLING, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { MessagesResult, MessagesStreamEvent, MessagesUsage } from '@floway-dev/protocols/messages';
import type { ResponsesResult, ResponsesStreamEvent } from '@floway-dev/protocols/responses';

const mapResponsesStopReason = (response: ResponsesResult): MessagesResult['stop_reason'] => {
  if (response.status === 'completed') {
    return response.output.some(item => item.type === 'function_call') ? 'tool_use' : 'end_turn';
  }

  if (response.status === 'incomplete' && response.incomplete_details?.reason === 'max_output_tokens') {
    return 'max_tokens';
  }

  return null;
};

const responsesUsageToMessagesUsage = (response: ResponsesResult, outputTokens: number): MessagesUsage => {
  const cachedTokens = response.usage?.input_tokens_details?.cached_tokens;
  const cacheWriteTokens = response.usage?.input_tokens_details?.cache_write_tokens;
  const writes = splitCacheWriteTokens(cacheWriteTokens, response.usage?.[USAGE_BILLING]);
  const { input: uncachedInputTokens } = splitInclusiveInputTokens(response.usage?.input_tokens ?? 0, cachedTokens, cacheWriteTokens);

  return {
    input_tokens: uncachedInputTokens,
    output_tokens: outputTokens,
    ...(cachedTokens !== undefined ? { cache_read_input_tokens: cachedTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cache_creation_input_tokens: cacheWriteTokens } : {}),
    ...(writes.cacheWrite1h > 0
      ? {
          cache_creation: {
            ephemeral_5m_input_tokens: writes.cacheWrite,
            ephemeral_1h_input_tokens: writes.cacheWrite1h,
          },
        }
      : {}),
    ...(response.service_tier === 'fast'
      ? { speed: 'fast' as const }
      : response.service_tier != null ? { service_tier: response.service_tier } : {}),
  };
};

const UPSTREAM_RESPONSES_MISSING_TERMINAL_MESSAGE = 'Upstream Responses stream ended without a terminal event.';

const upstreamResponsesEventsUntilTerminal = async function* (frames: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>): AsyncGenerator<ResponsesStreamEvent> {
  for await (const frame of frames) {
    if (frame.type === 'done') continue;

    yield frame.event;
    if (frame.event.type === 'response.completed' || frame.event.type === 'response.incomplete' || frame.event.type === 'response.failed' || frame.event.type === 'error') {
      return;
    }
  }

  throw new Error(UPSTREAM_RESPONSES_MISSING_TERMINAL_MESSAGE);
};

const hasResponsePartForOutput = (keys: Set<string>, outputIndex: number): boolean => {
  const prefix = `${outputIndex}:`;
  for (const key of keys) {
    if (key.startsWith(prefix)) return true;
  }
  return false;
};

interface ResponsesToMessagesStreamState {
  messageCompleted: boolean;
  nextBlockIndex: number;
  blockIndexByKey: Map<string, number>;
  openBlocks: Set<number>;
  emittedReasoningSummaryKeys: Set<string>;
  emittedReasoningSignatureOutputIndexes: Set<number>;
  emittedTextContentKeys: Set<string>;
  emittedFunctionArgumentOutputIndexes: Set<number>;
  outputOrder: ResponsesOutputOrderState;
  functionCallState: Map<
    number,
    {
      blockIndex: number;
      toolCallId: string;
      name: string;
    }
  >;
}

type ContentBlockInit = { type: 'text'; text: '' } | { type: 'thinking'; thinking: '' } | { type: 'redacted_thinking'; data: string };

const openBlock = (state: ResponsesToMessagesStreamState, key: string, contentBlock: ContentBlockInit, events: MessagesStreamEvent[]): number => {
  let blockIndex = state.blockIndexByKey.get(key);

  if (blockIndex === undefined) {
    blockIndex = state.nextBlockIndex++;
    state.blockIndexByKey.set(key, blockIndex);
  }

  if (!state.openBlocks.has(blockIndex)) {
    closeOpenBlocks(state, events);
    events.push({
      type: 'content_block_start',
      index: blockIndex,
      content_block: contentBlock,
    });
    state.openBlocks.add(blockIndex);
  }

  return blockIndex;
};

const openTextBlock = (state: ResponsesToMessagesStreamState, outputIndex: number, contentIndex: number, events: MessagesStreamEvent[]): number =>
  openBlock(state, `${outputIndex}:${contentIndex}`, { type: 'text', text: '' }, events);

const openThinkingBlock = (state: ResponsesToMessagesStreamState, outputIndex: number, events: MessagesStreamEvent[]): number =>
  openBlock(state, `${outputIndex}:0`, { type: 'thinking', thinking: '' }, events);

const openRedactedThinkingBlock = (state: ResponsesToMessagesStreamState, outputIndex: number, data: string, events: MessagesStreamEvent[]): number =>
  openBlock(state, `${outputIndex}:0`, { type: 'redacted_thinking', data }, events);

const closeOpenBlocks = (state: ResponsesToMessagesStreamState, events: MessagesStreamEvent[]): void => {
  for (const blockIndex of state.openBlocks) {
    events.push({ type: 'content_block_stop', index: blockIndex });
  }

  state.openBlocks.clear();
};

const closeAllBlocks = (state: ResponsesToMessagesStreamState, events: MessagesStreamEvent[]): void => {
  closeOpenBlocks(state, events);
  state.functionCallState.clear();
};

const handleResponseCreated = (response: ResponsesResult): MessagesStreamEvent[] => [
  {
    type: 'message_start',
    message: {
      id: response.id,
      type: 'message',
      role: 'assistant',
      content: [],
      model: response.model,
      stop_reason: null,
      stop_sequence: null,
      usage: responsesUsageToMessagesUsage(response, 0),
    },
  },
];

const handleOutputItemAdded = (event: ResponsesEvent<'response.output_item.added'>, state: ResponsesToMessagesStreamState): MessagesStreamEvent[] => {
  if (event.item.type !== 'function_call') return [];

  const blockIndex = state.nextBlockIndex++;
  const toolCallId = event.item.call_id ?? `tool_${blockIndex}`;
  const name = event.item.name ?? 'function';

  state.functionCallState.set(event.output_index, {
    blockIndex,
    toolCallId,
    name,
  });

  const events: MessagesStreamEvent[] = [];
  closeOpenBlocks(state, events);
  events.push({
    type: 'content_block_start',
    index: blockIndex,
    content_block: { type: 'tool_use', id: toolCallId, name, input: {} },
  });
  state.openBlocks.add(blockIndex);

  if (event.item.arguments.length > 0) {
    events.push({
      type: 'content_block_delta',
      index: blockIndex,
      delta: { type: 'input_json_delta', partial_json: event.item.arguments },
    });
    state.emittedFunctionArgumentOutputIndexes.add(event.output_index);
  }

  return events;
};

const handleOutputItemDone = (event: ResponsesEvent<'response.output_item.done'>, state: ResponsesToMessagesStreamState): MessagesStreamEvent[] => {
  if (event.item.type !== 'reasoning') return [];

  const hasEmittedSummary = hasResponsePartForOutput(state.emittedReasoningSummaryKeys, event.output_index);
  const trimmedSummary = event.item.summary
    .map(part => part.text)
    .join('')
    .trim();
  const packed = packReasoningSignature(event.item.id, event.item.encrypted_content ?? '');

  // No readable text on either the streamed summary or the final item: emit a
  // `redacted_thinking` carrier so the reasoning id (and any opaque content)
  // still round-trips to a downstream Messages client. Copilot rejects a
  // `thinking` block with empty text, hence the redacted shape here.
  if (!hasEmittedSummary && trimmedSummary === '') {
    const events: MessagesStreamEvent[] = [];
    openRedactedThinkingBlock(state, event.output_index, packed, events);
    state.emittedReasoningSignatureOutputIndexes.add(event.output_index);
    return events;
  }

  const events: MessagesStreamEvent[] = [];
  const blockIndex = openThinkingBlock(state, event.output_index, events);

  for (const [summaryIndex, part] of event.item.summary.entries()) {
    const key = responsesPartKey(event.output_index, summaryIndex);
    if (!part.text || state.emittedReasoningSummaryKeys.has(key)) continue;

    events.push({
      type: 'content_block_delta',
      index: blockIndex,
      delta: { type: 'thinking_delta', thinking: part.text },
    });
    state.emittedReasoningSummaryKeys.add(key);
  }

  // The signature carrier packs the reasoning id together with the opaque
  // `encrypted_content`, both of which are only known here at `output_item.done`
  // — summary-text deltas carry neither. Emit it once per reasoning item before
  // the thinking block closes so a downstream Messages client can echo the
  // packed value back and we recover the id (and clean blob) next turn.
  if (!state.emittedReasoningSignatureOutputIndexes.has(event.output_index)) {
    events.push({
      type: 'content_block_delta',
      index: blockIndex,
      delta: { type: 'signature_delta', signature: packed },
    });
    state.emittedReasoningSignatureOutputIndexes.add(event.output_index);
  }

  return events;
};

const handleThinkingDelta = (event: ResponsesEvent<'response.reasoning_summary_text.delta'>, state: ResponsesToMessagesStreamState): MessagesStreamEvent[] => {
  const events: MessagesStreamEvent[] = [];
  const blockIndex = openThinkingBlock(state, event.output_index, events);
  events.push({
    type: 'content_block_delta',
    index: blockIndex,
    delta: { type: 'thinking_delta', thinking: event.delta },
  });
  state.emittedReasoningSummaryKeys.add(responsesPartKey(event.output_index, event.summary_index));
  return events;
};

const handleThinkingDone = (event: ResponsesEvent<'response.reasoning_summary_text.done'>, state: ResponsesToMessagesStreamState): MessagesStreamEvent[] => {
  const events: MessagesStreamEvent[] = [];
  const blockIndex = openThinkingBlock(state, event.output_index, events);
  const key = responsesPartKey(event.output_index, event.summary_index);

  if (event.text && !state.emittedReasoningSummaryKeys.has(key)) {
    events.push({
      type: 'content_block_delta',
      index: blockIndex,
      delta: { type: 'thinking_delta', thinking: event.text },
    });
    state.emittedReasoningSummaryKeys.add(key);
  }

  return events;
};

const handleTextDelta = (event: ResponsesEvent<'response.output_text.delta'>, state: ResponsesToMessagesStreamState): MessagesStreamEvent[] => {
  if (!event.delta) return [];

  const events: MessagesStreamEvent[] = [];
  const blockIndex = openTextBlock(state, event.output_index, event.content_index, events);
  events.push({
    type: 'content_block_delta',
    index: blockIndex,
    delta: { type: 'text_delta', text: event.delta },
  });
  state.emittedTextContentKeys.add(responsesPartKey(event.output_index, event.content_index));
  return events;
};

const handleTextDone = (event: ResponsesEvent<'response.output_text.done'>, state: ResponsesToMessagesStreamState): MessagesStreamEvent[] => {
  const events: MessagesStreamEvent[] = [];
  const blockIndex = openTextBlock(state, event.output_index, event.content_index, events);

  const key = responsesPartKey(event.output_index, event.content_index);
  if (event.text && !state.emittedTextContentKeys.has(key)) {
    events.push({
      type: 'content_block_delta',
      index: blockIndex,
      delta: { type: 'text_delta', text: event.text },
    });
    state.emittedTextContentKeys.add(key);
  }

  return events;
};

const handleContentPartDone = (event: ResponsesEvent<'response.content_part.done'>, state: ResponsesToMessagesStreamState): MessagesStreamEvent[] => {
  if (event.part.type !== 'refusal') return [];

  const key = responsesPartKey(event.output_index, event.content_index);
  if (!event.part.refusal || state.emittedTextContentKeys.has(key)) return [];

  const events: MessagesStreamEvent[] = [];
  const blockIndex = openTextBlock(state, event.output_index, event.content_index, events);
  events.push({
    type: 'content_block_delta',
    index: blockIndex,
    delta: { type: 'text_delta', text: event.part.refusal },
  });
  state.emittedTextContentKeys.add(key);
  return events;
};

const handleFunctionArgumentsDelta = (event: ResponsesEvent<'response.function_call_arguments.delta'>, state: ResponsesToMessagesStreamState): MessagesStreamEvent[] => {
  if (!event.delta) return [];

  const functionCallState = state.functionCallState.get(event.output_index);
  if (!functionCallState) return [];

  state.emittedFunctionArgumentOutputIndexes.add(event.output_index);

  return [
    {
      type: 'content_block_delta',
      index: functionCallState.blockIndex,
      delta: { type: 'input_json_delta', partial_json: event.delta },
    },
  ];
};

const handleFunctionArgumentsDone = (event: ResponsesEvent<'response.function_call_arguments.done'>, state: ResponsesToMessagesStreamState): MessagesStreamEvent[] => {
  const functionCallState = state.functionCallState.get(event.output_index);
  if (!functionCallState) return [];

  state.functionCallState.delete(event.output_index);

  if (!event.arguments || state.emittedFunctionArgumentOutputIndexes.has(event.output_index)) {
    return [];
  }

  state.emittedFunctionArgumentOutputIndexes.add(event.output_index);

  return [
    {
      type: 'content_block_delta',
      index: functionCallState.blockIndex,
      delta: { type: 'input_json_delta', partial_json: event.arguments },
    },
  ];
};

const handleCompleted = (response: ResponsesResult, state: ResponsesToMessagesStreamState): MessagesStreamEvent[] => {
  const events: MessagesStreamEvent[] = [];
  closeAllBlocks(state, events);

  events.push(
    {
      type: 'message_delta',
      delta: {
        stop_reason: mapResponsesStopReason(response),
        stop_sequence: null,
      },
      usage: responsesUsageToMessagesUsage(response, response.usage?.output_tokens ?? 0),
    },
    { type: 'message_stop' },
  );
  state.messageCompleted = true;
  return events;
};

// A Responses upstream can report a context-exceeded failure inside the SSE
// stream (Codex emits `response.failed` with `error.code =
// context_length_exceeded`; some Copilot fronts surface a stream `error`
// event with the same code). We rewrite those into the same Anthropic
// `invalid_request_error` + `prompt is too long:` envelope the unary path
// uses, so a Messages client (Claude Code in particular) recognizes the
// condition and triggers auto-compaction whether the failure arrived
// pre-stream or mid-stream.
const handleStreamError = (
  state: ResponsesToMessagesStreamState,
  error: { code?: string; message?: string } | undefined,
  fallbackMessage: string,
): MessagesStreamEvent[] => {
  const events: MessagesStreamEvent[] = [];
  closeAllBlocks(state, events);
  state.messageCompleted = true;
  events.push({
    type: 'error',
    error: isContextExceededError(error)
      ? { type: 'invalid_request_error', message: PROMPT_TOO_LONG_MESSAGE }
      : { type: 'api_error', message: error?.message ?? fallbackMessage },
  });
  return events;
};

const handleFailed = (response: ResponsesResult, state: ResponsesToMessagesStreamState): MessagesStreamEvent[] =>
  handleStreamError(state, response.error ?? undefined, 'Response failed due to unknown error.');

const handleError = (event: ResponsesEvent<'error'>, state: ResponsesToMessagesStreamState): MessagesStreamEvent[] =>
  handleStreamError(state, { code: event.code, message: event.message }, 'An unexpected error occurred during streaming.');

export const createResponsesToMessagesStreamState = (): ResponsesToMessagesStreamState => ({
  messageCompleted: false,
  nextBlockIndex: 0,
  blockIndexByKey: new Map(),
  openBlocks: new Set(),
  emittedReasoningSummaryKeys: new Set(),
  emittedReasoningSignatureOutputIndexes: new Set(),
  emittedTextContentKeys: new Set(),
  emittedFunctionArgumentOutputIndexes: new Set(),
  outputOrder: createResponsesOutputOrderState(),
  functionCallState: new Map(),
});

const translateReadyResponsesEvent = (event: ResponsesStreamEvent, state: ResponsesToMessagesStreamState): MessagesStreamEvent[] => {
  recordResponsesOutputOrderEvent(event, state.outputOrder, () => true);

  switch (event.type) {
  case 'response.created':
    return handleResponseCreated((event as ResponsesEvent<'response.created'>).response);
  case 'response.output_item.added':
    return handleOutputItemAdded(event as ResponsesEvent<'response.output_item.added'>, state);
  case 'response.output_item.done':
    return handleOutputItemDone(event as ResponsesEvent<'response.output_item.done'>, state);
  case 'response.reasoning_summary_text.delta':
    return handleThinkingDelta(event as ResponsesEvent<'response.reasoning_summary_text.delta'>, state);
  case 'response.reasoning_summary_text.done':
    return handleThinkingDone(event as ResponsesEvent<'response.reasoning_summary_text.done'>, state);
  case 'response.output_text.delta':
    return handleTextDelta(event as ResponsesEvent<'response.output_text.delta'>, state);
  case 'response.output_text.done':
    return handleTextDone(event as ResponsesEvent<'response.output_text.done'>, state);
  case 'response.content_part.done':
    return handleContentPartDone(event as ResponsesEvent<'response.content_part.done'>, state);
  case 'response.function_call_arguments.delta':
    return handleFunctionArgumentsDelta(event as ResponsesEvent<'response.function_call_arguments.delta'>, state);
  case 'response.function_call_arguments.done':
    return handleFunctionArgumentsDone(event as ResponsesEvent<'response.function_call_arguments.done'>, state);
  case 'response.completed':
  case 'response.incomplete':
    return handleCompleted((event as ResponsesEvent<'response.completed' | 'response.incomplete'>).response, state);
  case 'response.failed':
    return handleFailed((event as ResponsesEvent<'response.failed'>).response, state);
  case 'error':
    return handleError(event as ResponsesEvent<'error'>, state);
  case 'ping':
    return [{ type: 'ping' }];
  default:
    return [];
  }
};

const takeNextReadyDeferredResponseEvent = (state: ResponsesToMessagesStreamState): ResponsesStreamEvent | undefined => {
  const nextReadyIndex = state.outputOrder.deferredEvents.findIndex(event => !shouldDeferForEarlierResponsesOutput(event, state.outputOrder));
  if (nextReadyIndex === -1) return undefined;

  const [event] = state.outputOrder.deferredEvents.splice(nextReadyIndex, 1);
  return event;
};

const flushReadyDeferredMessagesEvents = (state: ResponsesToMessagesStreamState): MessagesStreamEvent[] => {
  const events: MessagesStreamEvent[] = [];
  while (!state.messageCompleted && state.outputOrder.deferredEvents.length > 0) {
    const event = takeNextReadyDeferredResponseEvent(state);
    if (!event) break;
    events.push(...translateReadyResponsesEvent(event, state));
  }
  return events;
};

export const translateResponsesStreamEventToMessagesEvents = (event: ResponsesStreamEvent, state: ResponsesToMessagesStreamState): MessagesStreamEvent[] => {
  if (state.messageCompleted) return [];
  if (shouldDeferForEarlierResponsesOutput(event, state.outputOrder)) {
    state.outputOrder.deferredEvents.push(event);
    return [];
  }

  const events = translateReadyResponsesEvent(event, state);
  if (event.type === 'response.output_item.done') {
    events.push(...flushReadyDeferredMessagesEvents(state));
  }
  return events;
};

export const translateToSourceEvents = async function* (frames: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>): AsyncGenerator<ProtocolFrame<MessagesStreamEvent>> {
  const state = createResponsesToMessagesStreamState();

  for await (const event of upstreamResponsesEventsUntilTerminal(frames)) {
    for (const translated of translateResponsesStreamEventToMessagesEvents(event, state)) {
      yield eventFrame(translated);
    }
  }
};
