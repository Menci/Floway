import { hasReadableSummary, toOpenAIChatCompletionsReasoningItem } from '../shared/openai-chat-completions-and-openai-responses/reasoning.ts';
import { createOpenAIResponsesOutputOrderState, recordOpenAIResponsesOutputOrderEvent, type OpenAIResponsesOutputOrderState, shouldDeferForEarlierOpenAIResponsesOutput } from '../shared/via-openai-responses/openai-responses-stream-order.ts';
import { openaiResponsesPartKey } from '../shared/via-openai-responses/openai-responses-stream.ts';
import { doneFrame, eventFrame, splitInclusiveInputTokens, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsStreamEvent, OpenAIChatCompletionsResult, OpenAIChatCompletionsReasoningItem, OpenAIChatCompletionsDelta } from '@floway-dev/protocols/openai-chat-completions';
import { isOpenAIResponsesTerminalEvent, type OpenAIResponsesOutputItem, type OpenAIResponsesResult, type OpenAIResponsesStreamEvent } from '@floway-dev/protocols/openai-responses';

const mapOpenAIResponsesFinishReasonToOpenAIChatCompletionsFinishReason = (response: OpenAIResponsesResult): OpenAIChatCompletionsResult['choices'][0]['finish_reason'] =>
  response.status === 'incomplete' && response.incomplete_details?.reason === 'max_output_tokens'
    ? 'length'
    : response.status === 'completed' && response.output.some(item => item.type === 'function_call')
      ? 'tool_calls'
      : 'stop';

const UPSTREAM_OPENAI_RESPONSES_MISSING_TERMINAL_MESSAGE = 'Upstream OpenAI Responses stream ended without a terminal event.';

const upstreamOpenAIResponsesEventsUntilTerminal = async function* (frames: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEvent>>): AsyncGenerator<OpenAIResponsesStreamEvent> {
  for await (const frame of frames) {
    if (frame.type === 'done') continue;

    yield frame.event;
    if (isOpenAIResponsesTerminalEvent(frame.event)) {
      return;
    }
  }

  throw new Error(UPSTREAM_OPENAI_RESPONSES_MISSING_TERMINAL_MESSAGE);
};

interface OpenAIResponsesToOpenAIChatCompletionsStreamState {
  messageId: string;
  model: string;
  created: number;
  toolCallIndex: number;
  functionCallIndices: Map<number, number>;
  reasoningItems: OpenAIChatCompletionsReasoningItem[];
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
  outputOrder: OpenAIResponsesOutputOrderState;
  serviceTier?: OpenAIChatCompletionsStreamEvent['service_tier'];
  done: boolean;
}

export const createOpenAIResponsesToOpenAIChatCompletionsStreamState = (): OpenAIResponsesToOpenAIChatCompletionsStreamState => ({
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
  outputOrder: createOpenAIResponsesOutputOrderState(),
  done: false,
});

const trackReasoningOutputItem = (item: OpenAIResponsesOutputItem): boolean => item.type === 'reasoning';

const flushPendingReasoningChunks = (state: OpenAIResponsesToOpenAIChatCompletionsStreamState): OpenAIChatCompletionsStreamEvent[] => {
  if (state.reasoningItems.length === 0) return [];

  const reasoningItems = state.reasoningItems;
  state.reasoningItems = [];
  return [makeChunk(state, { reasoning_items: reasoningItems })];
};

const isReasoningOutputDone = (event: OpenAIResponsesStreamEvent): boolean => {
  if (event.type !== 'response.output_item.done') return false;
  return (event as Extract<OpenAIResponsesStreamEvent, { type: 'response.output_item.done' }>).item.type === 'reasoning';
};

const takeNextReadyDeferredResponseEvent = (state: OpenAIResponsesToOpenAIChatCompletionsStreamState, onlyReasoningOutputDone: boolean): OpenAIResponsesStreamEvent | undefined => {
  const nextReadyIndex = state.outputOrder.deferredEvents.findIndex(
    event => !shouldDeferForEarlierOpenAIResponsesOutput(event, state.outputOrder) && (!onlyReasoningOutputDone || isReasoningOutputDone(event)),
  );
  if (nextReadyIndex === -1) return undefined;

  const [event] = state.outputOrder.deferredEvents.splice(nextReadyIndex, 1);
  return event;
};

const flushReadyDeferredChatChunks = (state: OpenAIResponsesToOpenAIChatCompletionsStreamState, onlyReasoningOutputDone = false): OpenAIChatCompletionsStreamEvent[] => {
  const chunks: OpenAIChatCompletionsStreamEvent[] = [];
  while (state.outputOrder.deferredEvents.length > 0) {
    const event = takeNextReadyDeferredResponseEvent(state, onlyReasoningOutputDone);
    if (!event) break;
    chunks.push(...translateOpenAIResponsesEventToOpenAIChatCompletionsChunks(event, state));
  }
  return chunks;
};

const shouldProjectScalarReasoning = (outputIndex: number, state: OpenAIResponsesToOpenAIChatCompletionsStreamState): boolean => {
  // OpenAI Chat Completions scalar reasoning is a compatibility projection, not an ordered
  // reasoning IR; once the first OpenAI Responses reasoning output is chosen, later
  // reasoning outputs only travel through `reasoning_items[]`.
  state.firstScalarReasoningOutputIndex ??= outputIndex;
  return state.firstScalarReasoningOutputIndex === outputIndex;
};

type ReasoningSummaryEmitMode = 'delta' | 'done-fallback';

const emitReasoningSummaryText = (outputIndex: number, summaryIndex: number, text: string, state: OpenAIResponsesToOpenAIChatCompletionsStreamState, mode: ReasoningSummaryEmitMode): OpenAIChatCompletionsStreamEvent[] => {
  if (!text || !shouldProjectScalarReasoning(outputIndex, state)) return [];

  const key = openaiResponsesPartKey(outputIndex, summaryIndex);
  if (mode === 'done-fallback' && state.emittedReasoningSummaryKeys.has(key)) {
    return [];
  }

  state.emittedReasoningSummaryKeys.add(key);
  state.pendingReasoningSummaryTexts.delete(key);
  return [makeChunk(state, { reasoning_text: text })];
};

const queueReasoningSummaryDoneFallback = (outputIndex: number, summaryIndex: number, text: string, state: OpenAIResponsesToOpenAIChatCompletionsStreamState): void => {
  if (!text || !shouldProjectScalarReasoning(outputIndex, state)) return;

  const key = openaiResponsesPartKey(outputIndex, summaryIndex);
  if (state.emittedReasoningSummaryKeys.has(key)) return;

  state.pendingReasoningSummaryTexts.set(key, {
    outputIndex,
    summaryIndex,
    text,
  });
};

const flushReasoningSummaryDoneFallbacks = (state: OpenAIResponsesToOpenAIChatCompletionsStreamState, outputIndex?: number): OpenAIChatCompletionsStreamEvent[] => {
  const pending = [...state.pendingReasoningSummaryTexts.values()]
    .filter(item => outputIndex === undefined || item.outputIndex === outputIndex)
    .sort((a, b) => (a.outputIndex === b.outputIndex ? a.summaryIndex - b.summaryIndex : a.outputIndex - b.outputIndex));

  return pending.flatMap(item => emitReasoningSummaryText(item.outputIndex, item.summaryIndex, item.text, state, 'done-fallback'));
};

export const translateOpenAIResponsesEventToOpenAIChatCompletionsChunks = (event: OpenAIResponsesStreamEvent, state: OpenAIResponsesToOpenAIChatCompletionsStreamState): OpenAIChatCompletionsStreamEvent[] => {
  if (state.done) return [];
  if (shouldDeferForEarlierOpenAIResponsesOutput(event, state.outputOrder)) {
    state.outputOrder.deferredEvents.push(event);
    return [];
  }
  recordOpenAIResponsesOutputOrderEvent(event, state.outputOrder, trackReasoningOutputItem);

  switch (event.type) {
  case 'response.created': {
    const { response } = event as Extract<OpenAIResponsesStreamEvent, { type: 'response.created' }>;
    state.messageId = response.id;
    state.model = response.model;
    if (response.service_tier !== undefined) state.serviceTier = response.service_tier;
    return [makeChunk(state, { role: 'assistant' })];
  }

  case 'response.output_item.added': {
    const { item, output_index } = event as Extract<OpenAIResponsesStreamEvent, { type: 'response.output_item.added' }>;
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
    const { item, output_index } = event as Extract<OpenAIResponsesStreamEvent, { type: 'response.output_item.done' }>;
    if (item.type !== 'reasoning') return [];

    const chunks: OpenAIChatCompletionsStreamEvent[] = [];
    const reasoningItem = toOpenAIChatCompletionsReasoningItem(item);
    if (hasReadableSummary(reasoningItem)) state.reasoningItems.push(reasoningItem);

    for (const [summaryIndex, part] of item.summary.entries()) {
      chunks.push(...emitReasoningSummaryText(output_index, summaryIndex, part.text, state, 'done-fallback'));
    }
    chunks.push(...flushReasoningSummaryDoneFallbacks(state, output_index));

    return [...chunks, ...flushReadyDeferredChatChunks(state, true), ...flushPendingReasoningChunks(state), ...flushReadyDeferredChatChunks(state)];
  }

  case 'response.reasoning_summary_text.delta': {
    const { delta, output_index, summary_index } = event as Extract<OpenAIResponsesStreamEvent, { type: 'response.reasoning_summary_text.delta' }>;
    return emitReasoningSummaryText(output_index, summary_index, delta, state, 'delta');
  }

  case 'response.reasoning_summary_text.done': {
    const { text, output_index, summary_index } = event as Extract<OpenAIResponsesStreamEvent, { type: 'response.reasoning_summary_text.done' }>;
    queueReasoningSummaryDoneFallback(output_index, summary_index, text, state);
    return [];
  }

  case 'response.output_text.delta': {
    const { delta, output_index, content_index } = event as Extract<OpenAIResponsesStreamEvent, { type: 'response.output_text.delta' }>;
    if (delta) {
      state.emittedTextContentKeys.add(openaiResponsesPartKey(output_index, content_index));
    }
    return delta ? [makeChunk(state, { content: delta })] : [];
  }

  case 'response.output_text.done': {
    const { text, output_index, content_index } = event as Extract<OpenAIResponsesStreamEvent, { type: 'response.output_text.done' }>;
    const key = openaiResponsesPartKey(output_index, content_index);
    if (!text || state.emittedTextContentKeys.has(key)) return [];

    state.emittedTextContentKeys.add(key);
    return [makeChunk(state, { content: text })];
  }

  case 'response.refusal.delta': {
    const { delta, output_index, content_index } = event as Extract<OpenAIResponsesStreamEvent, { type: 'response.refusal.delta' }>;
    if (!delta) return [];

    state.emittedTextContentKeys.add(openaiResponsesPartKey(output_index, content_index));
    return [makeChunk(state, { refusal: delta })];
  }

  case 'response.refusal.done': {
    const { refusal, output_index, content_index } = event as Extract<OpenAIResponsesStreamEvent, { type: 'response.refusal.done' }>;
    const key = openaiResponsesPartKey(output_index, content_index);
    if (!refusal || state.emittedTextContentKeys.has(key)) return [];

    state.emittedTextContentKeys.add(key);
    return [makeChunk(state, { refusal })];
  }

  case 'response.content_part.done': {
    const { part, output_index, content_index } = event as Extract<OpenAIResponsesStreamEvent, { type: 'response.content_part.done' }>;
    if (part.type !== 'refusal') return [];

    const key = openaiResponsesPartKey(output_index, content_index);
    if (!part.refusal || state.emittedTextContentKeys.has(key)) return [];

    state.emittedTextContentKeys.add(key);
    return [makeChunk(state, { refusal: part.refusal })];
  }

  case 'response.function_call_arguments.delta': {
    const { delta, output_index } = event as Extract<OpenAIResponsesStreamEvent, { type: 'response.function_call_arguments.delta' }>;
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
    const { arguments: args, output_index } = event as Extract<OpenAIResponsesStreamEvent, { type: 'response.function_call_arguments.done' }>;
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
    const { response } = event as Extract<OpenAIResponsesStreamEvent, { type: 'response.completed' | 'response.incomplete' }>;
    const chunks: OpenAIChatCompletionsStreamEvent[] = [];
    if (response.service_tier !== undefined) state.serviceTier = response.service_tier;

    chunks.push(...flushReasoningSummaryDoneFallbacks(state));
    chunks.push(...flushPendingReasoningChunks(state));
    chunks.push(...flushReadyDeferredChatChunks(state));

    const chunk = makeChunk(state, {}, mapOpenAIResponsesFinishReasonToOpenAIChatCompletionsFinishReason(response));

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

const makeChunk = (state: OpenAIResponsesToOpenAIChatCompletionsStreamState, delta: OpenAIChatCompletionsDelta, finishReason: OpenAIChatCompletionsStreamEvent['choices'][0]['finish_reason'] = null): OpenAIChatCompletionsStreamEvent => ({
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
  state: OpenAIResponsesToOpenAIChatCompletionsStreamState,
  usage: NonNullable<OpenAIResponsesResult['usage']>,
): OpenAIChatCompletionsStreamEvent => {
  // Validated, not consumed: OpenAI Chat Completions names the same three input
  // buckets OpenAI Responses does, so the counts cross unchanged. The assertion is
  // this package's own, on the contract its output type declares.
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
    },
  };
};

interface OpenAIChatCompletionsErrorPayload {
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

const chatErrorPayloadFromOpenAIResponsesError = (event: Extract<OpenAIResponsesStreamEvent, { type: 'error' }>): OpenAIChatCompletionsErrorPayload => ({
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

const chatErrorPayloadFromOpenAIResponsesFailure = (event: Extract<OpenAIResponsesStreamEvent, { type: 'response.failed' }>): OpenAIChatCompletionsErrorPayload => {
  const response = event.response as OpenAIResponsesResult;
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

const chatErrorFrameFromOpenAIResponsesFatalEvent = (event: OpenAIResponsesStreamEvent): ProtocolFrame<OpenAIChatCompletionsStreamEvent> | undefined => {
  if (event.type === 'error') {
    // OpenAI-compatible Chat Completions streams can carry top-level error payloads;
    // OpenAIChatCompletionsStreamEvent only models successful chunk payloads.
    return eventFrame(chatErrorPayloadFromOpenAIResponsesError(event as Extract<OpenAIResponsesStreamEvent, { type: 'error' }>) as unknown as OpenAIChatCompletionsStreamEvent);
  }

  if (event.type === 'response.failed') {
    return eventFrame(chatErrorPayloadFromOpenAIResponsesFailure(event as Extract<OpenAIResponsesStreamEvent, { type: 'response.failed' }>) as unknown as OpenAIChatCompletionsStreamEvent);
  }

  return undefined;
};

export const translateToSourceEvents = async function* (frames: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEvent>>): AsyncGenerator<ProtocolFrame<OpenAIChatCompletionsStreamEvent>> {
  const state = createOpenAIResponsesToOpenAIChatCompletionsStreamState();

  for await (const event of upstreamOpenAIResponsesEventsUntilTerminal(frames)) {
    const fatalFrame = chatErrorFrameFromOpenAIResponsesFatalEvent(event);
    if (fatalFrame) {
      yield fatalFrame;
      return;
    }

    for (const translated of translateOpenAIResponsesEventToOpenAIChatCompletionsChunks(event, state)) {
      yield eventFrame(translated);
    }
  }

  yield doneFrame();
};
