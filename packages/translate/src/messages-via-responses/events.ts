import { packReasoningSignature } from '../shared/messages-and-responses/reasoning.ts';
import { isContextExceededError } from '../shared/messages-via/context-window-error.ts';
import { authoritativeStreamSuffix } from '../shared/via-responses/authoritative-stream-value.ts';
import { createResponsesOutputOrderState, recordResponsesOutputOrderEvent, type ResponsesOutputOrderState, shouldDeferForEarlierResponsesOutput } from '../shared/via-responses/responses-stream-order.ts';
import { responsesPartKey } from '../shared/via-responses/responses-stream.ts';
import { eventFrame, splitCacheWriteTokens, splitInclusiveInputTokens, type ProtocolFrame } from '@floway-dev/protocols/common';
import { PROMPT_TOO_LONG_MESSAGE, type MessagesResult, type MessagesStreamEvent, type MessagesUsage } from '@floway-dev/protocols/messages';
import { isResponsesTerminalEvent, type ResponsesResult, type ResponsesStreamEvent } from '@floway-dev/protocols/responses';

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
  const writes = splitCacheWriteTokens(cacheWriteTokens, 0);
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
    if (isResponsesTerminalEvent(frame.event)) {
      return;
    }
  }

  throw new Error(UPSTREAM_RESPONSES_MISSING_TERMINAL_MESSAGE);
};

const hasResponsePartForOutput = (values: ReadonlyMap<string, string>, outputIndex: number): boolean => {
  const prefix = `${outputIndex}:`;
  for (const key of values.keys()) {
    if (key.startsWith(prefix)) return true;
  }
  return false;
};

interface ResponsesToMessagesStreamState {
  messageCompleted: boolean;
  nextBlockIndex: number;
  blockIndexByKey: Map<string, number>;
  openBlocks: Set<number>;
  reasoningSummaryTexts: Map<string, string>;
  emittedReasoningSignatureOutputIndexes: Set<number>;
  contentTexts: Map<string, string>;
  refusalTexts: Map<number, Map<number, string>>;
  functionArguments: Map<number, string>;
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

const handleOutputItemAdded = (event: Extract<ResponsesStreamEvent, { type: 'response.output_item.added' }>, state: ResponsesToMessagesStreamState): MessagesStreamEvent[] => {
  if (event.item.type !== 'function_call') return [];

  const blockIndex = state.nextBlockIndex++;
  const toolCallId = event.item.call_id ?? `tool_${blockIndex}`;
  const name = event.item.name ?? 'function';

  state.functionCallState.set(event.output_index, {
    blockIndex,
    toolCallId,
    name,
  });
  state.functionArguments.set(event.output_index, event.item.arguments);

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
  }

  return events;
};

const handleOutputItemDone = (event: Extract<ResponsesStreamEvent, { type: 'response.output_item.done' }>, state: ResponsesToMessagesStreamState): MessagesStreamEvent[] => {
  if (event.item.type === 'function_call') {
    const events = handleFunctionArgumentsComplete(event.output_index, event.item.arguments, state);
    state.functionCallState.delete(event.output_index);
    state.functionArguments.delete(event.output_index);
    return events;
  }
  if (event.item.type !== 'reasoning') return [];

  const hasEmittedSummary = hasResponsePartForOutput(state.reasoningSummaryTexts, event.output_index);
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
    const suffix = authoritativeStreamSuffix(state.reasoningSummaryTexts.get(key) ?? '', part.text, `Responses reasoning summary ${key}`);
    if (part.text) state.reasoningSummaryTexts.set(key, part.text);
    if (!suffix) continue;

    events.push({
      type: 'content_block_delta',
      index: blockIndex,
      delta: { type: 'thinking_delta', thinking: suffix },
    });
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

const handleThinkingDelta = (event: Extract<ResponsesStreamEvent, { type: 'response.reasoning_summary_text.delta' }>, state: ResponsesToMessagesStreamState): MessagesStreamEvent[] => {
  const events: MessagesStreamEvent[] = [];
  const blockIndex = openThinkingBlock(state, event.output_index, events);
  const key = responsesPartKey(event.output_index, event.summary_index);
  state.reasoningSummaryTexts.set(key, (state.reasoningSummaryTexts.get(key) ?? '') + event.delta);
  events.push({
    type: 'content_block_delta',
    index: blockIndex,
    delta: { type: 'thinking_delta', thinking: event.delta },
  });
  return events;
};

const handleThinkingDone = (event: Extract<ResponsesStreamEvent, { type: 'response.reasoning_summary_text.done' }>, state: ResponsesToMessagesStreamState): MessagesStreamEvent[] => {
  const events: MessagesStreamEvent[] = [];
  const blockIndex = openThinkingBlock(state, event.output_index, events);
  const key = responsesPartKey(event.output_index, event.summary_index);
  const suffix = authoritativeStreamSuffix(state.reasoningSummaryTexts.get(key) ?? '', event.text, `Responses reasoning summary ${key}`);
  if (event.text) state.reasoningSummaryTexts.set(key, event.text);

  if (suffix) {
    events.push({
      type: 'content_block_delta',
      index: blockIndex,
      delta: { type: 'thinking_delta', thinking: suffix },
    });
  }

  return events;
};

const handleTextDelta = (event: Extract<ResponsesStreamEvent, { type: 'response.output_text.delta' }>, state: ResponsesToMessagesStreamState): MessagesStreamEvent[] => {
  if (!event.delta) return [];

  const events: MessagesStreamEvent[] = [];
  const blockIndex = openTextBlock(state, event.output_index, event.content_index, events);
  const key = responsesPartKey(event.output_index, event.content_index);
  state.contentTexts.set(key, (state.contentTexts.get(key) ?? '') + event.delta);
  events.push({
    type: 'content_block_delta',
    index: blockIndex,
    delta: { type: 'text_delta', text: event.delta },
  });
  return events;
};

const handleTextDone = (event: Extract<ResponsesStreamEvent, { type: 'response.output_text.done' }>, state: ResponsesToMessagesStreamState): MessagesStreamEvent[] => {
  const events: MessagesStreamEvent[] = [];
  const blockIndex = openTextBlock(state, event.output_index, event.content_index, events);

  const key = responsesPartKey(event.output_index, event.content_index);
  const suffix = authoritativeStreamSuffix(state.contentTexts.get(key) ?? '', event.text, `Responses output text ${key}`);
  if (event.text) state.contentTexts.set(key, event.text);
  if (suffix) {
    events.push({
      type: 'content_block_delta',
      index: blockIndex,
      delta: { type: 'text_delta', text: suffix },
    });
  }

  return events;
};

const handleContentPartDone = (event: Extract<ResponsesStreamEvent, { type: 'response.content_part.done' }>, state: ResponsesToMessagesStreamState): MessagesStreamEvent[] => {
  if (event.part.type !== 'refusal') return [];

  const key = responsesPartKey(event.output_index, event.content_index);
  const streamed = state.contentTexts.get(key) ?? '';
  authoritativeStreamSuffix(streamed, event.part.refusal, `Responses refusal ${key}`);
  const complete = event.part.refusal.length > 0 ? event.part.refusal : streamed;
  if (!complete) return [];

  const parts = state.refusalTexts.get(event.output_index) ?? new Map<number, string>();
  parts.set(event.content_index, complete);
  state.refusalTexts.set(event.output_index, parts);
  state.contentTexts.set(key, complete);
  return [];
};

const handleRefusalDelta = (event: Extract<ResponsesStreamEvent, { type: 'response.refusal.delta' }>, state: ResponsesToMessagesStreamState): MessagesStreamEvent[] => {
  const parts = state.refusalTexts.get(event.output_index) ?? new Map<number, string>();
  parts.set(event.content_index, (parts.get(event.content_index) ?? '') + event.delta);
  state.refusalTexts.set(event.output_index, parts);
  const key = responsesPartKey(event.output_index, event.content_index);
  state.contentTexts.set(key, (state.contentTexts.get(key) ?? '') + event.delta);
  return [];
};

const handleRefusalDone = (event: Extract<ResponsesStreamEvent, { type: 'response.refusal.done' }>, state: ResponsesToMessagesStreamState): MessagesStreamEvent[] => {
  const key = responsesPartKey(event.output_index, event.content_index);
  const streamed = state.contentTexts.get(key) ?? '';
  authoritativeStreamSuffix(streamed, event.refusal, `Responses refusal ${key}`);
  const complete = event.refusal.length > 0 ? event.refusal : streamed;
  const parts = state.refusalTexts.get(event.output_index) ?? new Map<number, string>();
  parts.set(event.content_index, complete);
  state.refusalTexts.set(event.output_index, parts);
  state.contentTexts.set(key, complete);
  return [];
};

const handleFunctionArgumentsDelta = (event: Extract<ResponsesStreamEvent, { type: 'response.function_call_arguments.delta' }>, state: ResponsesToMessagesStreamState): MessagesStreamEvent[] => {
  if (!event.delta) return [];

  const functionCallState = state.functionCallState.get(event.output_index);
  if (!functionCallState) return [];

  state.functionArguments.set(event.output_index, (state.functionArguments.get(event.output_index) ?? '') + event.delta);

  return [
    {
      type: 'content_block_delta',
      index: functionCallState.blockIndex,
      delta: { type: 'input_json_delta', partial_json: event.delta },
    },
  ];
};

const handleFunctionArgumentsComplete = (outputIndex: number, complete: string, state: ResponsesToMessagesStreamState): MessagesStreamEvent[] => {
  const functionCallState = state.functionCallState.get(outputIndex);
  if (!functionCallState) return [];

  const suffix = authoritativeStreamSuffix(state.functionArguments.get(outputIndex) ?? '', complete, `Responses function arguments for output ${outputIndex}`);
  if (complete) state.functionArguments.set(outputIndex, complete);
  if (!suffix) return [];

  return [
    {
      type: 'content_block_delta',
      index: functionCallState.blockIndex,
      delta: { type: 'input_json_delta', partial_json: suffix },
    },
  ];
};

const handleFunctionArgumentsDone = (event: Extract<ResponsesStreamEvent, { type: 'response.function_call_arguments.done' }>, state: ResponsesToMessagesStreamState): MessagesStreamEvent[] =>
  handleFunctionArgumentsComplete(event.output_index, event.arguments, state);

const handleCompleted = (response: ResponsesResult, state: ResponsesToMessagesStreamState): MessagesStreamEvent[] => {
  const events: MessagesStreamEvent[] = [];
  closeAllBlocks(state, events);

  const refusalText = [...state.refusalTexts.entries()]
    .sort(([left], [right]) => left - right)
    .flatMap(([, parts]) => [...parts.entries()].sort(([left], [right]) => left - right).map(([, text]) => text))
    .join('');
  const refused = state.refusalTexts.size > 0;

  events.push(
    {
      type: 'message_delta',
      delta: {
        stop_reason: refused ? 'refusal' : mapResponsesStopReason(response),
        ...(refused
          ? {
              stop_details: {
                type: 'refusal' as const,
                category: null,
                explanation: refusalText,
              },
            }
          : {}),
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

const handleFailed = (response: ResponsesResult, state: ResponsesToMessagesStreamState): MessagesStreamEvent[] => {
  const category = response.error?.code === 'cyber_policy'
    ? 'cyber' as const
    : response.error?.code === 'bio_policy' ? 'bio' as const : undefined;
  if (category === undefined) {
    return handleStreamError(state, response.error ?? undefined, 'Response failed due to unknown error.');
  }

  const events: MessagesStreamEvent[] = [];
  closeAllBlocks(state, events);
  events.push(
    {
      type: 'message_delta',
      delta: {
        stop_reason: 'refusal',
        stop_details: {
          type: 'refusal',
          category,
          explanation: response.error?.message ?? null,
        },
        stop_sequence: null,
      },
      usage: responsesUsageToMessagesUsage(response, response.usage?.output_tokens ?? 0),
    },
    { type: 'message_stop' },
  );
  state.messageCompleted = true;
  return events;
};

const handleError = (event: Extract<ResponsesStreamEvent, { type: 'error' }>, state: ResponsesToMessagesStreamState): MessagesStreamEvent[] =>
  handleStreamError(state, { code: event.code, message: event.message }, 'An unexpected error occurred during streaming.');

export const createResponsesToMessagesStreamState = (): ResponsesToMessagesStreamState => ({
  messageCompleted: false,
  nextBlockIndex: 0,
  blockIndexByKey: new Map(),
  openBlocks: new Set(),
  reasoningSummaryTexts: new Map(),
  emittedReasoningSignatureOutputIndexes: new Set(),
  contentTexts: new Map(),
  refusalTexts: new Map(),
  functionArguments: new Map(),
  outputOrder: createResponsesOutputOrderState(),
  functionCallState: new Map(),
});

const translateReadyResponsesEvent = (event: ResponsesStreamEvent, state: ResponsesToMessagesStreamState): MessagesStreamEvent[] => {
  recordResponsesOutputOrderEvent(event, state.outputOrder, () => true);

  switch (event.type) {
  case 'response.created':
    return handleResponseCreated((event as Extract<ResponsesStreamEvent, { type: 'response.created' }>).response);
  case 'response.output_item.added':
    return handleOutputItemAdded(event as Extract<ResponsesStreamEvent, { type: 'response.output_item.added' }>, state);
  case 'response.output_item.done':
    return handleOutputItemDone(event as Extract<ResponsesStreamEvent, { type: 'response.output_item.done' }>, state);
  case 'response.reasoning_summary_text.delta':
    return handleThinkingDelta(event as Extract<ResponsesStreamEvent, { type: 'response.reasoning_summary_text.delta' }>, state);
  case 'response.reasoning_summary_text.done':
    return handleThinkingDone(event as Extract<ResponsesStreamEvent, { type: 'response.reasoning_summary_text.done' }>, state);
  case 'response.output_text.delta':
    return handleTextDelta(event as Extract<ResponsesStreamEvent, { type: 'response.output_text.delta' }>, state);
  case 'response.output_text.done':
    return handleTextDone(event as Extract<ResponsesStreamEvent, { type: 'response.output_text.done' }>, state);
  case 'response.refusal.delta':
    return handleRefusalDelta(event as Extract<ResponsesStreamEvent, { type: 'response.refusal.delta' }>, state);
  case 'response.refusal.done':
    return handleRefusalDone(event as Extract<ResponsesStreamEvent, { type: 'response.refusal.done' }>, state);
  case 'response.content_part.done':
    return handleContentPartDone(event as Extract<ResponsesStreamEvent, { type: 'response.content_part.done' }>, state);
  case 'response.function_call_arguments.delta':
    return handleFunctionArgumentsDelta(event as Extract<ResponsesStreamEvent, { type: 'response.function_call_arguments.delta' }>, state);
  case 'response.function_call_arguments.done':
    return handleFunctionArgumentsDone(event as Extract<ResponsesStreamEvent, { type: 'response.function_call_arguments.done' }>, state);
  case 'response.completed':
  case 'response.incomplete':
    return handleCompleted((event as Extract<ResponsesStreamEvent, { type: 'response.completed' | 'response.incomplete' }>).response, state);
  case 'response.failed':
    return handleFailed((event as Extract<ResponsesStreamEvent, { type: 'response.failed' }>).response, state);
  case 'error':
    return handleError(event as Extract<ResponsesStreamEvent, { type: 'error' }>, state);
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
