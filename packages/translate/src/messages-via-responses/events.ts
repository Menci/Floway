import { parseToolArgumentsObject } from '../shared/messages/tool-arguments.ts';
import { responsesReasoningToMessagesBlock } from '../shared/messages-and-responses/reasoning.ts';
import { createResponsesOutputOrderState, recordResponseOutputOrderEvent, type ResponsesOutputOrderState, shouldDeferForEarlierResponseOutput } from '../shared/via-responses/responses-stream-order.ts';
import { type ResponseEvent, responsePartKey } from '../shared/via-responses/responses-stream.ts';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { MessagesAssistantContentBlock, MessagesResponse, MessagesStreamEventData } from '@floway-dev/protocols/messages';
import type { ResponseOutputContentBlock, ResponseOutputItem, ResponsesResult, ResponsesStreamEvent, ResponseStreamEvent } from '@floway-dev/protocols/responses';

const combineMessageTextContent = (content: ResponseOutputContentBlock[] | undefined): string => {
  if (!Array.isArray(content)) return '';

  // Compromise: our local Messages/Chat shapes have no dedicated refusal block,
  // so keep Responses refusal text visible rather than inventing extra
  // translated semantics at this boundary.
  return content
    .map(block => {
      if (block.type === 'output_text') return block.text;
      if (block.type === 'refusal') return block.refusal;
      return '';
    })
    .join('');
};

const mapOutputToMessagesContent = (output: ResponseOutputItem[]): MessagesAssistantContentBlock[] => {
  const content: MessagesAssistantContentBlock[] = [];

  for (const item of output) {
    switch (item.type) {
    case 'reasoning': {
      const block = responsesReasoningToMessagesBlock(item);
      if (block) content.push(block);
      break;
    }
    case 'function_call':
      if (item.name && item.call_id) {
        content.push({
          type: 'tool_use',
          id: item.call_id,
          name: item.name,
          input: parseToolArgumentsObject(item.arguments),
        });
      }
      break;
    case 'message': {
      const text = combineMessageTextContent(item.content);
      if (text.length > 0) content.push({ type: 'text', text });
      break;
    }
    }
  }

  return content;
};

const mapResponsesStopReason = (response: ResponsesResult): MessagesResponse['stop_reason'] => {
  if (response.status === 'completed') {
    return response.output.some(item => item.type === 'function_call') ? 'tool_use' : 'end_turn';
  }

  if (response.status === 'incomplete' && response.incomplete_details?.reason === 'max_output_tokens') {
    return 'max_tokens';
  }

  return null;
};

// Exported for the unit tests under `events_test.ts`; the only production
// caller is `handleCompleted` below, which uses it for terminal Responses ->
// Messages projection of usage and stop_reason at stream close.
export const translateResponsesToMessagesResponse = (response: ResponsesResult): MessagesResponse => {
  const content = mapOutputToMessagesContent(response.output);
  const finalContent = content.length > 0 ? content : response.output_text ? [{ type: 'text' as const, text: response.output_text }] : [];

  const inputTokens = response.usage?.input_tokens ?? 0;
  const cachedTokens = response.usage?.input_tokens_details?.cached_tokens;

  return {
    id: response.id,
    type: 'message',
    role: 'assistant',
    content: finalContent,
    model: response.model,
    stop_reason: mapResponsesStopReason(response),
    stop_sequence: null,
    usage: {
      input_tokens: inputTokens - (cachedTokens ?? 0),
      output_tokens: response.usage?.output_tokens ?? 0,
      ...(cachedTokens !== undefined ? { cache_read_input_tokens: cachedTokens } : {}),
    },
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

type ContentBlockInit = { type: 'text'; text: '' } | { type: 'thinking'; thinking: '' };

const openBlock = (state: ResponsesToMessagesStreamState, key: string, contentBlock: ContentBlockInit, events: MessagesStreamEventData[]): number => {
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

const openTextBlock = (state: ResponsesToMessagesStreamState, outputIndex: number, contentIndex: number, events: MessagesStreamEventData[]): number =>
  openBlock(state, `${outputIndex}:${contentIndex}`, { type: 'text', text: '' }, events);

const openThinkingBlock = (state: ResponsesToMessagesStreamState, outputIndex: number, events: MessagesStreamEventData[]): number =>
  openBlock(state, `${outputIndex}:0`, { type: 'thinking', thinking: '' }, events);

const closeOpenBlocks = (state: ResponsesToMessagesStreamState, events: MessagesStreamEventData[]): void => {
  for (const blockIndex of state.openBlocks) {
    events.push({ type: 'content_block_stop', index: blockIndex });
  }

  state.openBlocks.clear();
};

const closeAllBlocks = (state: ResponsesToMessagesStreamState, events: MessagesStreamEventData[]): void => {
  closeOpenBlocks(state, events);
  state.functionCallState.clear();
};

const handleResponseCreated = (response: ResponsesResult): MessagesStreamEventData[] => {
  const cachedTokens = response.usage?.input_tokens_details?.cached_tokens;

  return [
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
        usage: {
          input_tokens: (response.usage?.input_tokens ?? 0) - (cachedTokens ?? 0),
          output_tokens: 0,
          ...(cachedTokens !== undefined ? { cache_read_input_tokens: cachedTokens } : {}),
        },
      },
    },
  ];
};

const handleOutputItemAdded = (event: ResponseEvent<'response.output_item.added'>, state: ResponsesToMessagesStreamState): MessagesStreamEventData[] => {
  if (event.item.type !== 'function_call') return [];

  const blockIndex = state.nextBlockIndex++;
  const toolCallId = event.item.call_id ?? `tool_${blockIndex}`;
  const name = event.item.name ?? 'function';

  state.functionCallState.set(event.output_index, {
    blockIndex,
    toolCallId,
    name,
  });

  const events: MessagesStreamEventData[] = [];
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

const handleOutputItemDone = (event: ResponseEvent<'response.output_item.done'>, state: ResponsesToMessagesStreamState): MessagesStreamEventData[] => {
  if (event.item.type !== 'reasoning') return [];

  const hasEmittedSummary = hasResponsePartForOutput(state.emittedReasoningSummaryKeys, event.output_index);
  const trimmedSummary = event.item.summary
    .map(part => part.text)
    .join('')
    .trim();

  if (!hasEmittedSummary && trimmedSummary === '') {
    return [];
  }

  const events: MessagesStreamEventData[] = [];
  const blockIndex = openThinkingBlock(state, event.output_index, events);

  for (const [summaryIndex, part] of event.item.summary.entries()) {
    const key = responsePartKey(event.output_index, summaryIndex);
    if (!part.text || state.emittedReasoningSummaryKeys.has(key)) continue;

    events.push({
      type: 'content_block_delta',
      index: blockIndex,
      delta: { type: 'thinking_delta', thinking: part.text },
    });
    state.emittedReasoningSummaryKeys.add(key);
  }

  return events;
};

const handleThinkingDelta = (event: ResponseEvent<'response.reasoning_summary_text.delta'>, state: ResponsesToMessagesStreamState): MessagesStreamEventData[] => {
  const events: MessagesStreamEventData[] = [];
  const blockIndex = openThinkingBlock(state, event.output_index, events);
  events.push({
    type: 'content_block_delta',
    index: blockIndex,
    delta: { type: 'thinking_delta', thinking: event.delta },
  });
  state.emittedReasoningSummaryKeys.add(responsePartKey(event.output_index, event.summary_index));
  return events;
};

const handleThinkingDone = (event: ResponseEvent<'response.reasoning_summary_text.done'>, state: ResponsesToMessagesStreamState): MessagesStreamEventData[] => {
  const events: MessagesStreamEventData[] = [];
  const blockIndex = openThinkingBlock(state, event.output_index, events);
  const key = responsePartKey(event.output_index, event.summary_index);

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

const handleTextDelta = (event: ResponseEvent<'response.output_text.delta'>, state: ResponsesToMessagesStreamState): MessagesStreamEventData[] => {
  if (!event.delta) return [];

  const events: MessagesStreamEventData[] = [];
  const blockIndex = openTextBlock(state, event.output_index, event.content_index, events);
  events.push({
    type: 'content_block_delta',
    index: blockIndex,
    delta: { type: 'text_delta', text: event.delta },
  });
  state.emittedTextContentKeys.add(responsePartKey(event.output_index, event.content_index));
  return events;
};

const handleTextDone = (event: ResponseEvent<'response.output_text.done'>, state: ResponsesToMessagesStreamState): MessagesStreamEventData[] => {
  const events: MessagesStreamEventData[] = [];
  const blockIndex = openTextBlock(state, event.output_index, event.content_index, events);

  const key = responsePartKey(event.output_index, event.content_index);
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

const handleContentPartDone = (event: ResponseEvent<'response.content_part.done'>, state: ResponsesToMessagesStreamState): MessagesStreamEventData[] => {
  if (event.part.type !== 'refusal') return [];

  const key = responsePartKey(event.output_index, event.content_index);
  if (!event.part.refusal || state.emittedTextContentKeys.has(key)) return [];

  const events: MessagesStreamEventData[] = [];
  const blockIndex = openTextBlock(state, event.output_index, event.content_index, events);
  events.push({
    type: 'content_block_delta',
    index: blockIndex,
    delta: { type: 'text_delta', text: event.part.refusal },
  });
  state.emittedTextContentKeys.add(key);
  return events;
};

const handleFunctionArgumentsDelta = (event: ResponseEvent<'response.function_call_arguments.delta'>, state: ResponsesToMessagesStreamState): MessagesStreamEventData[] => {
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

const handleFunctionArgumentsDone = (event: ResponseEvent<'response.function_call_arguments.done'>, state: ResponsesToMessagesStreamState): MessagesStreamEventData[] => {
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

const handleCompleted = (response: ResponsesResult, state: ResponsesToMessagesStreamState): MessagesStreamEventData[] => {
  const events: MessagesStreamEventData[] = [];
  closeAllBlocks(state, events);

  const messagesResponse = translateResponsesToMessagesResponse(response);
  events.push(
    {
      type: 'message_delta',
      delta: {
        stop_reason: messagesResponse.stop_reason,
        stop_sequence: messagesResponse.stop_sequence,
      },
      usage: messagesResponse.usage,
    },
    { type: 'message_stop' },
  );
  state.messageCompleted = true;
  return events;
};

const handleStreamError = (state: ResponsesToMessagesStreamState, message: string): MessagesStreamEventData[] => {
  const events: MessagesStreamEventData[] = [];
  closeAllBlocks(state, events);
  state.messageCompleted = true;
  events.push({
    type: 'error',
    error: {
      type: 'api_error',
      message,
    },
  });
  return events;
};

const handleFailed = (response: ResponsesResult, state: ResponsesToMessagesStreamState): MessagesStreamEventData[] =>
  handleStreamError(state, response.error?.message ?? 'Response failed due to unknown error.');

const handleError = (event: ResponseEvent<'error'>, state: ResponsesToMessagesStreamState): MessagesStreamEventData[] =>
  handleStreamError(state, typeof event.message === 'string' ? event.message : 'An unexpected error occurred during streaming.');

export const createResponsesToMessagesStreamState = (): ResponsesToMessagesStreamState => ({
  messageCompleted: false,
  nextBlockIndex: 0,
  blockIndexByKey: new Map(),
  openBlocks: new Set(),
  emittedReasoningSummaryKeys: new Set(),
  emittedTextContentKeys: new Set(),
  emittedFunctionArgumentOutputIndexes: new Set(),
  outputOrder: createResponsesOutputOrderState(),
  functionCallState: new Map(),
});

const translateReadyResponseEvent = (event: ResponseStreamEvent, state: ResponsesToMessagesStreamState): MessagesStreamEventData[] => {
  recordResponseOutputOrderEvent(event, state.outputOrder, () => true);

  switch (event.type) {
  case 'response.created':
    return handleResponseCreated((event as ResponseEvent<'response.created'>).response);
  case 'response.output_item.added':
    return handleOutputItemAdded(event as ResponseEvent<'response.output_item.added'>, state);
  case 'response.output_item.done':
    return handleOutputItemDone(event as ResponseEvent<'response.output_item.done'>, state);
  case 'response.reasoning_summary_text.delta':
    return handleThinkingDelta(event as ResponseEvent<'response.reasoning_summary_text.delta'>, state);
  case 'response.reasoning_summary_text.done':
    return handleThinkingDone(event as ResponseEvent<'response.reasoning_summary_text.done'>, state);
  case 'response.output_text.delta':
    return handleTextDelta(event as ResponseEvent<'response.output_text.delta'>, state);
  case 'response.output_text.done':
    return handleTextDone(event as ResponseEvent<'response.output_text.done'>, state);
  case 'response.content_part.done':
    return handleContentPartDone(event as ResponseEvent<'response.content_part.done'>, state);
  case 'response.function_call_arguments.delta':
    return handleFunctionArgumentsDelta(event as ResponseEvent<'response.function_call_arguments.delta'>, state);
  case 'response.function_call_arguments.done':
    return handleFunctionArgumentsDone(event as ResponseEvent<'response.function_call_arguments.done'>, state);
  case 'response.completed':
  case 'response.incomplete':
    return handleCompleted((event as ResponseEvent<'response.completed' | 'response.incomplete'>).response, state);
  case 'response.failed':
    return handleFailed((event as ResponseEvent<'response.failed'>).response, state);
  case 'error':
    return handleError(event as ResponseEvent<'error'>, state);
  case 'ping':
    return [{ type: 'ping' }];
  default:
    return [];
  }
};

const takeNextReadyDeferredResponseEvent = (state: ResponsesToMessagesStreamState): ResponseStreamEvent | undefined => {
  const nextReadyIndex = state.outputOrder.deferredEvents.findIndex(event => !shouldDeferForEarlierResponseOutput(event, state.outputOrder));
  if (nextReadyIndex === -1) return undefined;

  const [event] = state.outputOrder.deferredEvents.splice(nextReadyIndex, 1);
  return event;
};

const flushReadyDeferredMessagesEvents = (state: ResponsesToMessagesStreamState): MessagesStreamEventData[] => {
  const events: MessagesStreamEventData[] = [];
  while (!state.messageCompleted && state.outputOrder.deferredEvents.length > 0) {
    const event = takeNextReadyDeferredResponseEvent(state);
    if (!event) break;
    events.push(...translateReadyResponseEvent(event, state));
  }
  return events;
};

export const translateResponsesStreamEventToMessagesEvents = (event: ResponseStreamEvent, state: ResponsesToMessagesStreamState): MessagesStreamEventData[] => {
  if (state.messageCompleted) return [];
  if (shouldDeferForEarlierResponseOutput(event, state.outputOrder)) {
    state.outputOrder.deferredEvents.push(event);
    return [];
  }

  const events = translateReadyResponseEvent(event, state);
  if (event.type === 'response.output_item.done') {
    events.push(...flushReadyDeferredMessagesEvents(state));
  }
  return events;
};

export const translateToSourceEvents = async function* (frames: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>): AsyncGenerator<ProtocolFrame<MessagesStreamEventData>> {
  const state = createResponsesToMessagesStreamState();

  for await (const event of upstreamResponsesEventsUntilTerminal(frames)) {
    for (const translated of translateResponsesStreamEventToMessagesEvents(event, state)) {
      yield eventFrame(translated);
    }
  }
};
