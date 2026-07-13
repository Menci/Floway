import { toChatCompletionsReasoningItem } from '../shared/chat-completions-and-responses/reasoning.ts';
import { createResponsesOutputOrderState, recordResponsesOutputOrderEvent, type ResponsesOutputOrderState, shouldDeferForEarlierResponsesOutput } from '../shared/via-responses/responses-stream-order.ts';
import { type ResponsesEvent, responsesPartKey } from '../shared/via-responses/responses-stream.ts';
import type { ChatCompletionsStreamEvent, ChatCompletionsResult, ChatCompletionsReasoningItem, ChatCompletionsDelta } from '@floway-dev/protocols/chat-completions';
import { doneFrame, eventFrame, splitInclusiveInputTokens, USAGE_BILLING, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { ResponsesOutputItem, ResponsesResult, ResponsesStreamEvent } from '@floway-dev/protocols/responses';

const mapResponsesFinishReasonToChatCompletionsFinishReason = (response: ResponsesResult): ChatCompletionsResult['choices'][0]['finish_reason'] =>
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
  reasoningItems: ChatCompletionsReasoningItem[];
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
  serviceTier?: ChatCompletionsStreamEvent['service_tier'];
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

const trackReasoningOutputItem = (item: ResponsesOutputItem): boolean => item.type === 'reasoning';

const hasReadableSummary = (item: ChatCompletionsReasoningItem): boolean => item.summary?.some(part => part.text) === true;

const flushPendingReasoningChunks = (state: ResponsesToChatCompletionsStreamState): ChatCompletionsStreamEvent[] => {
  if (state.reasoningItems.length === 0) return [];

  const reasoningItems = state.reasoningItems;
  state.reasoningItems = [];
  return [makeChunk(state, { reasoning_items: reasoningItems })];
};

const isReasoningOutputDone = (event: ResponsesStreamEvent): boolean => {
  if (event.type !== 'response.output_item.done') return false;
  return (event as ResponsesEvent<'response.output_item.done'>).item.type === 'reasoning';
};

const takeNextReadyDeferredResponseEvent = (state: ResponsesToChatCompletionsStreamState, onlyReasoningOutputDone: boolean): ResponsesStreamEvent | undefined => {
  const nextReadyIndex = state.outputOrder.deferredEvents.findIndex(
    event => !shouldDeferForEarlierResponsesOutput(event, state.outputOrder) && (!onlyReasoningOutputDone || isReasoningOutputDone(event)),
  );
  if (nextReadyIndex === -1) return undefined;

  const [event] = state.outputOrder.deferredEvents.splice(nextReadyIndex, 1);
  return event;
};

const flushReadyDeferredChatChunks = (state: ResponsesToChatCompletionsStreamState, onlyReasoningOutputDone = false): ChatCompletionsStreamEvent[] => {
  const chunks: ChatCompletionsStreamEvent[] = [];
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

const emitReasoningSummaryText = (outputIndex: number, summaryIndex: number, text: string, state: ResponsesToChatCompletionsStreamState, mode: ReasoningSummaryEmitMode): ChatCompletionsStreamEvent[] => {
  if (!text || !shouldProjectScalarReasoning(outputIndex, state)) return [];

  const key = responsesPartKey(outputIndex, summaryIndex);
  if (mode === 'done-fallback' && state.emittedReasoningSummaryKeys.has(key)) {
    return [];
  }

  state.emittedReasoningSummaryKeys.add(key);
  state.pendingReasoningSummaryTexts.delete(key);
  return [makeChunk(state, { reasoning_text: text })];
};

const queueReasoningSummaryDoneFallback = (outputIndex: number, summaryIndex: number, text: string, state: ResponsesToChatCompletionsStreamState): void => {
  if (!text || !shouldProjectScalarReasoning(outputIndex, state)) return;

  const key = responsesPartKey(outputIndex, summaryIndex);
  if (state.emittedReasoningSummaryKeys.has(key)) return;

  state.pendingReasoningSummaryTexts.set(key, {
    outputIndex,
    summaryIndex,
    text,
  });
};

const flushReasoningSummaryDoneFallbacks = (state: ResponsesToChatCompletionsStreamState, outputIndex?: number): ChatCompletionsStreamEvent[] => {
  const pending = [...state.pendingReasoningSummaryTexts.values()]
    .filter(item => outputIndex === undefined || item.outputIndex === outputIndex)
    .sort((a, b) => (a.outputIndex === b.outputIndex ? a.summaryIndex - b.summaryIndex : a.outputIndex - b.outputIndex));

  return pending.flatMap(item => emitReasoningSummaryText(item.outputIndex, item.summaryIndex, item.text, state, 'done-fallback'));
};

export const translateResponsesEventToChatCompletionsChunks = (event: ResponsesStreamEvent, state: ResponsesToChatCompletionsStreamState): ChatCompletionsStreamEvent[] => {
  if (state.done) return [];
  if (shouldDeferForEarlierResponsesOutput(event, state.outputOrder)) {
    state.outputOrder.deferredEvents.push(event);
    return [];
  }
  recordResponsesOutputOrderEvent(event, state.outputOrder, trackReasoningOutputItem);

  switch (event.type) {
  case 'response.created': {
    const { response } = event as ResponsesEvent<'response.created'>;
    state.messageId = response.id;
    state.model = response.model;
    if (response.service_tier !== undefined) state.serviceTier = response.service_tier;
    return [makeChunk(state, { role: 'assistant' })];
  }

  case 'response.output_item.added': {
    const { item, output_index } = event as ResponsesEvent<'response.output_item.added'>;
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
    const { item, output_index } = event as ResponsesEvent<'response.output_item.done'>;
    if (item.type !== 'reasoning') return [];

    const chunks: ChatCompletionsStreamEvent[] = [];
    const reasoningItem = toChatCompletionsReasoningItem(item);
    if (hasReadableSummary(reasoningItem)) state.reasoningItems.push(reasoningItem);

    for (const [summaryIndex, part] of item.summary.entries()) {
      chunks.push(...emitReasoningSummaryText(output_index, summaryIndex, part.text, state, 'done-fallback'));
    }
    chunks.push(...flushReasoningSummaryDoneFallbacks(state, output_index));

    return [...chunks, ...flushReadyDeferredChatChunks(state, true), ...flushPendingReasoningChunks(state), ...flushReadyDeferredChatChunks(state)];
  }

  case 'response.reasoning_summary_text.delta': {
    const { delta, output_index, summary_index } = event as ResponsesEvent<'response.reasoning_summary_text.delta'>;
    return emitReasoningSummaryText(output_index, summary_index, delta, state, 'delta');
  }

  case 'response.reasoning_summary_text.done': {
    const { text, output_index, summary_index } = event as ResponsesEvent<'response.reasoning_summary_text.done'>;
    queueReasoningSummaryDoneFallback(output_index, summary_index, text, state);
    return [];
  }

  case 'response.output_text.delta': {
    const { delta, output_index, content_index } = event as ResponsesEvent<'response.output_text.delta'>;
    if (delta) {
      state.emittedTextContentKeys.add(responsesPartKey(output_index, content_index));
    }
    return delta ? [makeChunk(state, { content: delta })] : [];
  }

  case 'response.output_text.done': {
    const { text, output_index, content_index } = event as ResponsesEvent<'response.output_text.done'>;
    const key = responsesPartKey(output_index, content_index);
    if (!text || state.emittedTextContentKeys.has(key)) return [];

    state.emittedTextContentKeys.add(key);
    return [makeChunk(state, { content: text })];
  }

  case 'response.content_part.done': {
    const { part, output_index, content_index } = event as ResponsesEvent<'response.content_part.done'>;
    if (part.type !== 'refusal') return [];

    const key = responsesPartKey(output_index, content_index);
    if (!part.refusal || state.emittedTextContentKeys.has(key)) return [];

    state.emittedTextContentKeys.add(key);
    return [makeChunk(state, { content: part.refusal })];
  }

  case 'response.function_call_arguments.delta': {
    const { delta, output_index } = event as ResponsesEvent<'response.function_call_arguments.delta'>;
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
    const { arguments: args, output_index } = event as ResponsesEvent<'response.function_call_arguments.done'>;
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
    const { response } = event as ResponsesEvent<'response.completed' | 'response.incomplete'>;
    const chunks: ChatCompletionsStreamEvent[] = [];
    if (response.service_tier !== undefined) state.serviceTier = response.service_tier;

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

const makeChunk = (state: ResponsesToChatCompletionsStreamState, delta: ChatCompletionsDelta, finishReason: ChatCompletionsStreamEvent['choices'][0]['finish_reason'] = null): ChatCompletionsStreamEvent => ({
  id: state.messageId,
  object: 'chat.completion.chunk',
  created: state.created,
  model: state.model,
  ...(state.serviceTier !== undefined ? { service_tier: state.serviceTier } : {}),
  choices: [
    {
      index: 0,
      delta,
      finish_reason: finishReason,
    },
  ],
});

const makeUsageChunk = (
  state: ResponsesToChatCompletionsStreamState,
  usage: NonNullable<ResponsesResult['usage']>,
): ChatCompletionsStreamEvent => {
  splitInclusiveInputTokens(
    usage.input_tokens,
    usage.input_tokens_details?.cached_tokens,
    usage.input_tokens_details?.cache_write_tokens,
  );
  return {
    id: state.messageId,
    object: 'chat.completion.chunk',
    created: state.created,
    model: state.model,
    choices: [],
    ...(state.serviceTier !== undefined ? { service_tier: state.serviceTier } : {}),
    usage: {
      prompt_tokens: usage.input_tokens,
      completion_tokens: usage.output_tokens,
      total_tokens: usage.total_tokens,
      ...(usage.input_tokens_details?.cached_tokens !== undefined || usage.input_tokens_details?.cache_write_tokens !== undefined
        ? {
            prompt_tokens_details: {
              ...(usage.input_tokens_details.cached_tokens !== undefined ? { cached_tokens: usage.input_tokens_details.cached_tokens } : {}),
              ...(usage.input_tokens_details.cache_write_tokens !== undefined
                ? { cache_creation_input_tokens: usage.input_tokens_details.cache_write_tokens }
                : {}),
            },
          }
        : {}),
      ...(usage[USAGE_BILLING] !== undefined ? { [USAGE_BILLING]: usage[USAGE_BILLING] } : {}),
    },
  };
};

interface ChatCompletionsErrorPayload {
  error: {
    message: string;
    type: string;
    code?: string;
    name?: string;
    stack?: string;
    cause?: unknown;
    target_api?: string;
  };
}

const stringField = (value: unknown, fallback: string): string => (typeof value === 'string' && value.length > 0 ? value : fallback);

const debugFieldsFrom = (value: Record<string, unknown>) => ({
  ...(typeof value.name === 'string' ? { name: value.name } : {}),
  ...(typeof value.stack === 'string' ? { stack: value.stack } : {}),
  ...(value.cause !== undefined ? { cause: value.cause } : {}),
  ...(typeof value.target_api === 'string' ? { target_api: value.target_api } : {}),
});

const chatErrorPayloadFromResponsesError = (event: ResponsesEvent<'error'>): ChatCompletionsErrorPayload => ({
  error: {
    message: event.message,
    type: event.code ?? 'api_error',
    ...(event.code ? { code: event.code } : {}),
    ...(event.name ? { name: event.name } : {}),
    ...(event.stack ? { stack: event.stack } : {}),
    ...(event.cause !== undefined ? { cause: event.cause } : {}),
    ...(event.target_api ? { target_api: event.target_api } : {}),
  },
});

const isObjectLike = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const chatErrorPayloadFromResponsesFailure = (event: ResponsesEvent<'response.failed'>): ChatCompletionsErrorPayload => {
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

const chatErrorFrameFromResponsesFatalEvent = (event: ResponsesStreamEvent): ProtocolFrame<ChatCompletionsStreamEvent> | undefined => {
  if (event.type === 'error') {
    // OpenAI-compatible Chat streams can carry top-level error payloads;
    // ChatCompletionsStreamEvent only models successful chunk payloads.
    return eventFrame(chatErrorPayloadFromResponsesError(event as ResponsesEvent<'error'>) as unknown as ChatCompletionsStreamEvent);
  }

  if (event.type === 'response.failed') {
    return eventFrame(chatErrorPayloadFromResponsesFailure(event as ResponsesEvent<'response.failed'>) as unknown as ChatCompletionsStreamEvent);
  }

  return undefined;
};

export const translateToSourceEvents = async function* (frames: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>): AsyncGenerator<ProtocolFrame<ChatCompletionsStreamEvent>> {
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
