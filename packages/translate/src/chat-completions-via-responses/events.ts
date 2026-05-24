import { toChatReasoningItem } from '../shared/chat-and-responses/reasoning.ts';
import { createResponsesOutputOrderState, recordResponseOutputOrderEvent, type ResponsesOutputOrderState, shouldDeferForEarlierResponseOutput } from '../shared/via-responses/responses-stream-order.ts';
import { type ResponseEvent, responsePartKey } from '../shared/via-responses/responses-stream.ts';
import type { ChatCompletionChunk, ChatCompletionResponse, ChatReasoningItem, Delta } from '@floway-dev/protocols/chat-completions';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { ResponseOutputItem, ResponsesResult, ResponsesStreamEvent, ResponseStreamEvent } from '@floway-dev/protocols/responses';

const mapResponsesFinishReasonToChatCompletionsFinishReason = (response: ResponsesResult): ChatCompletionResponse['choices'][0]['finish_reason'] =>
  response.status === 'incomplete' && response.incomplete_details?.reason === 'max_output_tokens'
    ? 'length'
    : response.status === 'completed' && response.output.some(item => item.type === 'function_call')
      ? 'tool_calls'
      : 'stop';

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

interface ResponsesToChatCompletionsStreamState {
  messageId: string;
  model: string;
  created: number;
  toolCallIndex: number;
  functionCallIndices: Map<number, number>;
  reasoningItems: ChatReasoningItem[];
  firstScalarReasoningOutputIndex?: number;
  pendingReasoningSummaryTexts: Map<
    string,
    {
      outputIndex: number;
      summaryIndex: number;
      text: string;
    }
  >;
  emittedReasoningSummaryKeys: Set<string>;
  emittedTextContentKeys: Set<string>;
  emittedFunctionArgumentOutputIndexes: Set<number>;
  outputOrder: ResponsesOutputOrderState;
  done: boolean;
}

export const createResponsesToChatCompletionsStreamState = (): ResponsesToChatCompletionsStreamState => ({
  messageId: '',
  model: '',
  created: Math.floor(Date.now() / 1000),
  toolCallIndex: -1,
  functionCallIndices: new Map(),
  reasoningItems: [],
  pendingReasoningSummaryTexts: new Map(),
  emittedReasoningSummaryKeys: new Set(),
  emittedTextContentKeys: new Set(),
  emittedFunctionArgumentOutputIndexes: new Set(),
  outputOrder: createResponsesOutputOrderState(),
  done: false,
});

const trackReasoningOutputItem = (item: ResponseOutputItem): boolean => item.type === 'reasoning';

const hasReadableSummary = (item: ChatReasoningItem): boolean => item.summary?.some(part => part.text) === true;

const flushPendingReasoningChunks = (state: ResponsesToChatCompletionsStreamState): ChatCompletionChunk[] => {
  if (state.reasoningItems.length === 0) return [];

  const reasoningItems = state.reasoningItems;
  state.reasoningItems = [];
  return [makeChunk(state, { reasoning_items: reasoningItems })];
};

const isReasoningOutputDone = (event: ResponseStreamEvent): boolean => {
  if (event.type !== 'response.output_item.done') return false;
  return (event as ResponseEvent<'response.output_item.done'>).item.type === 'reasoning';
};

const takeNextReadyDeferredResponseEvent = (state: ResponsesToChatCompletionsStreamState, onlyReasoningOutputDone: boolean): ResponseStreamEvent | undefined => {
  const nextReadyIndex = state.outputOrder.deferredEvents.findIndex(
    event => !shouldDeferForEarlierResponseOutput(event, state.outputOrder) && (!onlyReasoningOutputDone || isReasoningOutputDone(event)),
  );
  if (nextReadyIndex === -1) return undefined;

  const [event] = state.outputOrder.deferredEvents.splice(nextReadyIndex, 1);
  return event;
};

const flushReadyDeferredChatChunks = (state: ResponsesToChatCompletionsStreamState, onlyReasoningOutputDone = false): ChatCompletionChunk[] => {
  const chunks: ChatCompletionChunk[] = [];
  while (state.outputOrder.deferredEvents.length > 0) {
    const event = takeNextReadyDeferredResponseEvent(state, onlyReasoningOutputDone);
    if (!event) break;
    chunks.push(...translateResponsesEventToChatCompletionsChunks(event, state));
  }
  return chunks;
};

const shouldProjectScalarReasoning = (outputIndex: number, state: ResponsesToChatCompletionsStreamState): boolean => {
  // Chat scalar reasoning is a compatibility projection, not an ordered
  // reasoning IR; once the first Responses reasoning output is chosen, later
  // reasoning outputs only travel through `reasoning_items[]`.
  state.firstScalarReasoningOutputIndex ??= outputIndex;
  return state.firstScalarReasoningOutputIndex === outputIndex;
};

type ReasoningSummaryEmitMode = 'delta' | 'done-fallback';

const emitReasoningSummaryText = (outputIndex: number, summaryIndex: number, text: string, state: ResponsesToChatCompletionsStreamState, mode: ReasoningSummaryEmitMode): ChatCompletionChunk[] => {
  if (!text || !shouldProjectScalarReasoning(outputIndex, state)) return [];

  const key = responsePartKey(outputIndex, summaryIndex);
  if (mode === 'done-fallback' && state.emittedReasoningSummaryKeys.has(key)) {
    return [];
  }

  state.emittedReasoningSummaryKeys.add(key);
  state.pendingReasoningSummaryTexts.delete(key);
  return [makeChunk(state, { reasoning_text: text })];
};

const queueReasoningSummaryDoneFallback = (outputIndex: number, summaryIndex: number, text: string, state: ResponsesToChatCompletionsStreamState): void => {
  if (!text || !shouldProjectScalarReasoning(outputIndex, state)) return;

  const key = responsePartKey(outputIndex, summaryIndex);
  if (state.emittedReasoningSummaryKeys.has(key)) return;

  state.pendingReasoningSummaryTexts.set(key, {
    outputIndex,
    summaryIndex,
    text,
  });
};

const flushReasoningSummaryDoneFallbacks = (state: ResponsesToChatCompletionsStreamState, outputIndex?: number): ChatCompletionChunk[] => {
  const pending = [...state.pendingReasoningSummaryTexts.values()]
    .filter(item => outputIndex === undefined || item.outputIndex === outputIndex)
    .sort((a, b) => (a.outputIndex === b.outputIndex ? a.summaryIndex - b.summaryIndex : a.outputIndex - b.outputIndex));

  return pending.flatMap(item => emitReasoningSummaryText(item.outputIndex, item.summaryIndex, item.text, state, 'done-fallback'));
};

export const translateResponsesEventToChatCompletionsChunks = (event: ResponseStreamEvent, state: ResponsesToChatCompletionsStreamState): ChatCompletionChunk[] => {
  if (state.done) return [];
  if (shouldDeferForEarlierResponseOutput(event, state.outputOrder)) {
    state.outputOrder.deferredEvents.push(event);
    return [];
  }
  recordResponseOutputOrderEvent(event, state.outputOrder, trackReasoningOutputItem);

  switch (event.type) {
  case 'response.created': {
    const { response } = event as ResponseEvent<'response.created'>;
    state.messageId = response.id;
    state.model = response.model;
    return [makeChunk(state, { role: 'assistant' })];
  }

  case 'response.output_item.added': {
    const { item, output_index } = event as ResponseEvent<'response.output_item.added'>;
    if (item.type !== 'function_call') return [];

    state.toolCallIndex++;
    state.functionCallIndices.set(output_index, state.toolCallIndex);

    return [
      makeChunk(state, {
        tool_calls: [
          {
            index: state.toolCallIndex,
            id: item.call_id,
            type: 'function',
            function: {
              name: item.name,
              arguments: '',
            },
          },
        ],
      }),
    ];
  }

  case 'response.output_item.done': {
    const { item, output_index } = event as ResponseEvent<'response.output_item.done'>;
    if (item.type !== 'reasoning') return [];

    const chunks: ChatCompletionChunk[] = [];
    const reasoningItem = toChatReasoningItem(item);
    if (hasReadableSummary(reasoningItem)) state.reasoningItems.push(reasoningItem);

    for (const [summaryIndex, part] of item.summary.entries()) {
      chunks.push(...emitReasoningSummaryText(output_index, summaryIndex, part.text, state, 'done-fallback'));
    }
    chunks.push(...flushReasoningSummaryDoneFallbacks(state, output_index));

    return [...chunks, ...flushReadyDeferredChatChunks(state, true), ...flushPendingReasoningChunks(state), ...flushReadyDeferredChatChunks(state)];
  }

  case 'response.reasoning_summary_text.delta': {
    const { delta, output_index, summary_index } = event as ResponseEvent<'response.reasoning_summary_text.delta'>;
    return emitReasoningSummaryText(output_index, summary_index, delta, state, 'delta');
  }

  case 'response.reasoning_summary_text.done': {
    const { text, output_index, summary_index } = event as ResponseEvent<'response.reasoning_summary_text.done'>;
    queueReasoningSummaryDoneFallback(output_index, summary_index, text, state);
    return [];
  }

  case 'response.output_text.delta': {
    const { delta, output_index, content_index } = event as ResponseEvent<'response.output_text.delta'>;
    if (delta) {
      state.emittedTextContentKeys.add(responsePartKey(output_index, content_index));
    }
    return delta ? [makeChunk(state, { content: delta })] : [];
  }

  case 'response.output_text.done': {
    const { text, output_index, content_index } = event as ResponseEvent<'response.output_text.done'>;
    const key = responsePartKey(output_index, content_index);
    if (!text || state.emittedTextContentKeys.has(key)) return [];

    state.emittedTextContentKeys.add(key);
    return [makeChunk(state, { content: text })];
  }

  case 'response.content_part.done': {
    const { part, output_index, content_index } = event as ResponseEvent<'response.content_part.done'>;
    if (part.type !== 'refusal') return [];

    const key = responsePartKey(output_index, content_index);
    if (!part.refusal || state.emittedTextContentKeys.has(key)) return [];

    state.emittedTextContentKeys.add(key);
    return [makeChunk(state, { content: part.refusal })];
  }

  case 'response.function_call_arguments.delta': {
    const { delta, output_index } = event as ResponseEvent<'response.function_call_arguments.delta'>;
    if (!delta) return [];

    const toolCallIndex = state.functionCallIndices.get(output_index);
    if (toolCallIndex === undefined) return [];

    state.emittedFunctionArgumentOutputIndexes.add(output_index);
    return [
      makeChunk(state, {
        tool_calls: [
          {
            index: toolCallIndex,
            function: { arguments: delta },
          },
        ],
      }),
    ];
  }

  case 'response.function_call_arguments.done': {
    const { arguments: args, output_index } = event as ResponseEvent<'response.function_call_arguments.done'>;
    if (!args || state.emittedFunctionArgumentOutputIndexes.has(output_index)) {
      return [];
    }

    const toolCallIndex = state.functionCallIndices.get(output_index);
    if (toolCallIndex === undefined) return [];

    state.emittedFunctionArgumentOutputIndexes.add(output_index);
    return [
      makeChunk(state, {
        tool_calls: [
          {
            index: toolCallIndex,
            function: { arguments: args },
          },
        ],
      }),
    ];
  }

  case 'response.completed':
  case 'response.incomplete': {
    const { response } = event as ResponseEvent<'response.completed' | 'response.incomplete'>;
    const chunks: ChatCompletionChunk[] = [];

    chunks.push(...flushReasoningSummaryDoneFallbacks(state));
    chunks.push(...flushPendingReasoningChunks(state));
    chunks.push(...flushReadyDeferredChatChunks(state));

    const chunk = makeChunk(state, {}, mapResponsesFinishReasonToChatCompletionsFinishReason(response));

    state.done = true;
    chunks.push(chunk);
    if (response.usage) chunks.push(makeUsageChunk(state, response.usage));
    return chunks;
  }

  case 'response.failed':
    state.done = true;
    return [];

  default:
    return [];
  }
};

const makeChunk = (state: ResponsesToChatCompletionsStreamState, delta: Delta, finishReason: ChatCompletionChunk['choices'][0]['finish_reason'] = null): ChatCompletionChunk => ({
  id: state.messageId,
  object: 'chat.completion.chunk',
  created: state.created,
  model: state.model,
  choices: [
    {
      index: 0,
      delta,
      finish_reason: finishReason,
    },
  ],
});

const makeUsageChunk = (state: ResponsesToChatCompletionsStreamState, usage: NonNullable<ResponsesResult['usage']>): ChatCompletionChunk => ({
  id: state.messageId,
  object: 'chat.completion.chunk',
  created: state.created,
  model: state.model,
  choices: [],
  usage: {
    prompt_tokens: usage.input_tokens,
    completion_tokens: usage.output_tokens,
    total_tokens: usage.total_tokens,
    ...(usage.input_tokens_details?.cached_tokens !== undefined
      ? {
          prompt_tokens_details: {
            cached_tokens: usage.input_tokens_details.cached_tokens,
          },
        }
      : {}),
  },
});

interface ChatErrorPayload {
  error: {
    message: string;
    type: string;
    code?: string;
    name?: string;
    stack?: string;
    cause?: unknown;
    source_api?: string;
    target_api?: string;
  };
}

const stringField = (value: unknown, fallback: string): string => (typeof value === 'string' && value.length > 0 ? value : fallback);

const debugFieldsFrom = (value: Record<string, unknown>) => ({
  ...(typeof value.name === 'string' ? { name: value.name } : {}),
  ...(typeof value.stack === 'string' ? { stack: value.stack } : {}),
  ...(value.cause !== undefined ? { cause: value.cause } : {}),
  ...(typeof value.source_api === 'string' ? { source_api: value.source_api } : {}),
  ...(typeof value.target_api === 'string' ? { target_api: value.target_api } : {}),
});

const chatErrorPayloadFromResponsesError = (event: ResponseEvent<'error'>): ChatErrorPayload => ({
  error: {
    message: event.message,
    type: event.code ?? 'api_error',
    ...(event.code ? { code: event.code } : {}),
    ...(event.name ? { name: event.name } : {}),
    ...(event.stack ? { stack: event.stack } : {}),
    ...(event.cause !== undefined ? { cause: event.cause } : {}),
    ...(event.source_api ? { source_api: event.source_api } : {}),
    ...(event.target_api ? { target_api: event.target_api } : {}),
  },
});

const isObjectLike = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const chatErrorPayloadFromResponsesFailure = (event: ResponseEvent<'response.failed'>): ChatErrorPayload => {
  const response = event.response as ResponsesResult;
  const error = isObjectLike(response.error) ? response.error : undefined;

  return {
    error: {
      message: stringField(error?.message, 'Response failed due to unknown error.'),
      type: stringField(error?.type, 'api_error'),
      ...(typeof error?.code === 'string' ? { code: error.code } : {}),
      ...(error ? debugFieldsFrom(error) : {}),
    },
  };
};

const chatErrorFrameFromResponsesFatalEvent = (event: ResponseStreamEvent): ProtocolFrame<ChatCompletionChunk> | undefined => {
  if (event.type === 'error') {
    // OpenAI-compatible Chat streams can carry top-level error payloads;
    // ChatCompletionChunk only models successful chunk payloads.
    return eventFrame(chatErrorPayloadFromResponsesError(event as ResponseEvent<'error'>) as unknown as ChatCompletionChunk);
  }

  if (event.type === 'response.failed') {
    return eventFrame(chatErrorPayloadFromResponsesFailure(event as ResponseEvent<'response.failed'>) as unknown as ChatCompletionChunk);
  }

  return undefined;
};

export const translateToSourceEvents = async function* (frames: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>): AsyncGenerator<ProtocolFrame<ChatCompletionChunk>> {
  const state = createResponsesToChatCompletionsStreamState();

  for await (const event of upstreamResponsesEventsUntilTerminal(frames)) {
    const fatalFrame = chatErrorFrameFromResponsesFatalEvent(event);
    if (fatalFrame) {
      yield fatalFrame;
      return;
    }

    for (const translated of translateResponsesEventToChatCompletionsChunks(event, state)) {
      yield eventFrame(translated);
    }
  }

  yield doneFrame();
};
