import { createOpenAIResponsesPrivateState, observeOpenAIResponsesPrivate, finalizeOpenAIResponsesPrivate, recordOpenAIResponsesChatProjection } from '../shared/via-openai-responses/assistant-message-private.ts';
import { openaiResponsesPartKey } from '../shared/via-openai-responses/openai-responses-stream.ts';
import { doneFrame, eventFrame, splitInclusiveInputTokens, type ProtocolFrame } from '@floway-dev/protocols/common';
import { OpenAIChatCompletionsAssistantMessagePrivate, type OpenAIChatCompletionsStreamEvent, type OpenAIChatCompletionsResult, type OpenAIChatCompletionsAssistantDelta } from '@floway-dev/protocols/openai-chat-completions';
import { isOpenAIResponsesTerminalEvent, type OpenAIResponsesResultEx, type OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

const mapOpenAIResponsesFinishReasonToOpenAIChatCompletionsFinishReason = (response: OpenAIResponsesResultEx): OpenAIChatCompletionsResult['choices'][0]['finish_reason'] =>
  response.status === 'incomplete' && response.incomplete_details?.reason === 'max_output_tokens'
    ? 'length'
    : response.status === 'completed' && response.output.some(item => item.type === 'function_call')
      ? 'tool_calls'
      : 'stop';

const UPSTREAM_OPENAI_RESPONSES_MISSING_TERMINAL_MESSAGE = 'Upstream OpenAI Responses stream ended without a terminal event.';

const upstreamOpenAIResponsesEventsUntilTerminal = async function* (frames: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx>>): AsyncGenerator<OpenAIResponsesStreamEventEx> {
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
  privateState: ReturnType<typeof createOpenAIResponsesPrivateState>;
  emittedTextContentKeys: Set<string>;
  emittedFunctionArgumentOutputIndexes: Set<number>;
  serviceTier?: OpenAIChatCompletionsStreamEvent['service_tier'];
  done: boolean;
}

export const createOpenAIResponsesToOpenAIChatCompletionsStreamState = (): OpenAIResponsesToOpenAIChatCompletionsStreamState => ({
  messageId: '',
  model: '',
  created: Math.floor(Date.now() / 1000),
  toolCallIndex: -1,
  functionCallIndices: new Map(),
  privateState: createOpenAIResponsesPrivateState(),
  emittedTextContentKeys: new Set(),
  emittedFunctionArgumentOutputIndexes: new Set(),
  done: false,
});

const translateOpenAIResponsesEvent = (event: OpenAIResponsesStreamEventEx, state: OpenAIResponsesToOpenAIChatCompletionsStreamState): OpenAIChatCompletionsStreamEvent[] => {
  if (state.done) return [];
  const reasoningChunks = observeOpenAIResponsesPrivate(event, state.privateState).map(reasoningText => makeChunk(state, { [OpenAIChatCompletionsAssistantMessagePrivate]: { reasoningText } }));
  switch (event.type) {
  case 'response.created': {
    const { response } = event as Extract<OpenAIResponsesStreamEventEx, { type: 'response.created' }>;
    state.messageId = response.id;
    state.model = response.model;
    if (response.service_tier !== undefined) state.serviceTier = response.service_tier;
    return [makeChunk(state, { role: 'assistant' })];
  }

  case 'response.output_item.added': {
    const { item, output_index } = event as Extract<OpenAIResponsesStreamEventEx, { type: 'response.output_item.added' }>;
    if (item.type === 'reasoning') return reasoningChunks;
    if (item.type === 'message') return item.content.flatMap((part, content_index) => {
      if (part.type !== 'output_text' || !part.text) return [];
      state.emittedTextContentKeys.add(openaiResponsesPartKey(output_index, content_index));
      return [makeChunk(state, { content: part.text })];
    });
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
    const { item, output_index } = event;
    if (item.type === 'message') return item.content.flatMap((part, content_index) => {
      if (part.type !== 'output_text' || state.emittedTextContentKeys.has(openaiResponsesPartKey(output_index, content_index))) return [];
      state.emittedTextContentKeys.add(openaiResponsesPartKey(output_index, content_index));
      return [makeChunk(state, { content: part.text })];
    });
    if (item.type === 'function_call') {
      if (state.emittedFunctionArgumentOutputIndexes.has(output_index)) return [];
      const start = state.functionCallIndices.has(output_index) ? [] : translateOpenAIResponsesEvent({ type: 'response.output_item.added', output_index, item }, state);
      const index = state.functionCallIndices.get(output_index)!;
      state.emittedFunctionArgumentOutputIndexes.add(output_index);
      return [...start, makeChunk(state, { tool_calls: [{ index, function: { arguments: item.arguments } }] })];
    }
    return reasoningChunks;
  }
  case 'response.reasoning_summary_text.delta':
  case 'response.reasoning_summary_text.done':
  case 'response.reasoning_summary_part.done':
  case 'response.reasoning_text.delta':
  case 'response.reasoning_text.done':
    return reasoningChunks;

  case 'response.output_text.delta': {
    const { delta, output_index, content_index } = event as Extract<OpenAIResponsesStreamEventEx, { type: 'response.output_text.delta' }>;
    if (delta) {
      state.emittedTextContentKeys.add(openaiResponsesPartKey(output_index, content_index));
    }
    return delta ? [makeChunk(state, { content: delta })] : [];
  }

  case 'response.output_text.done': {
    const { text, output_index, content_index } = event as Extract<OpenAIResponsesStreamEventEx, { type: 'response.output_text.done' }>;
    const key = openaiResponsesPartKey(output_index, content_index);
    if (!text || state.emittedTextContentKeys.has(key)) return [];

    state.emittedTextContentKeys.add(key);
    return [makeChunk(state, { content: text })];
  }

  case 'response.refusal.delta': {
    const { delta, output_index, content_index } = event as Extract<OpenAIResponsesStreamEventEx, { type: 'response.refusal.delta' }>;
    if (!delta) return [];

    state.emittedTextContentKeys.add(openaiResponsesPartKey(output_index, content_index));
    return [makeChunk(state, { refusal: delta })];
  }

  case 'response.refusal.done': {
    const { refusal, output_index, content_index } = event as Extract<OpenAIResponsesStreamEventEx, { type: 'response.refusal.done' }>;
    const key = openaiResponsesPartKey(output_index, content_index);
    if (!refusal || state.emittedTextContentKeys.has(key)) return [];

    state.emittedTextContentKeys.add(key);
    return [makeChunk(state, { refusal })];
  }

  case 'response.content_part.added':
  case 'response.content_part.done': {
    const { part, output_index, content_index } = event as Extract<OpenAIResponsesStreamEventEx, { type: 'response.content_part.done' }>;
    if (part.type === 'reasoning_text') return reasoningChunks;
    if (part.type === 'output_text') {
      const key = openaiResponsesPartKey(output_index, content_index);
      if (!part.text || state.emittedTextContentKeys.has(key)) return [];
      state.emittedTextContentKeys.add(key);
      return [makeChunk(state, { content: part.text })];
    }
    if (part.type !== 'refusal') return [];

    const key = openaiResponsesPartKey(output_index, content_index);
    if (!part.refusal || state.emittedTextContentKeys.has(key)) return [];

    state.emittedTextContentKeys.add(key);
    return [makeChunk(state, { refusal: part.refusal })];
  }

  case 'response.function_call_arguments.delta': {
    const { delta, output_index } = event as Extract<OpenAIResponsesStreamEventEx, { type: 'response.function_call_arguments.delta' }>;
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
    const { arguments: args, output_index } = event as Extract<OpenAIResponsesStreamEventEx, { type: 'response.function_call_arguments.done' }>;
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
    const { response } = event as Extract<OpenAIResponsesStreamEventEx, { type: 'response.completed' | 'response.incomplete' }>;
    const chunks: OpenAIChatCompletionsStreamEvent[] = reasoningChunks;
    response.output.forEach((item, output_index) => {
      if (item.type === 'reasoning') return;
      const done = { type: 'response.output_item.done' as const, item, output_index };
      const projected = translateOpenAIResponsesEvent(done, state);
      recordOpenAIResponsesChatProjection(done, projected, state.privateState);
      chunks.push(...projected);
    });
    if (response.service_tier !== undefined) state.serviceTier = response.service_tier;

    recordOpenAIResponsesChatProjection(event, [], state.privateState);
    const sidecar = finalizeOpenAIResponsesPrivate(state.privateState);
    if (sidecar !== undefined) chunks.push(makeChunk(state, { [OpenAIChatCompletionsAssistantMessagePrivate]: { sidecar } }));

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

export const translateOpenAIResponsesEventToOpenAIChatCompletionsChunks = (event: OpenAIResponsesStreamEventEx, state: OpenAIResponsesToOpenAIChatCompletionsStreamState): OpenAIChatCompletionsStreamEvent[] => {
  const chunks = translateOpenAIResponsesEvent(event, state);
  if (event.type !== 'response.completed' && event.type !== 'response.incomplete') recordOpenAIResponsesChatProjection(event, chunks, state.privateState);
  return chunks;
};

const makeChunk = (state: OpenAIResponsesToOpenAIChatCompletionsStreamState, delta: OpenAIChatCompletionsAssistantDelta, finishReason: OpenAIChatCompletionsStreamEvent['choices'][0]['finish_reason'] = null): OpenAIChatCompletionsStreamEvent => ({
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
  usage: NonNullable<OpenAIResponsesResultEx['usage']>,
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

const chatErrorPayloadFromOpenAIResponsesError = (event: Extract<OpenAIResponsesStreamEventEx, { type: 'error' }>): OpenAIChatCompletionsErrorPayload => {
  const error = 'error' in event ? event.error : event;
  return {
    error: {
      message: error.message,
      type: 'error' in event ? event.error.type ?? error.code ?? 'api_error' : error.code ?? 'api_error',
      ...(error.code ? { code: error.code } : {}),
      ...(error.name ? { name: error.name } : {}),
      ...(error.stack ? { stack: error.stack } : {}),
      ...(error.cause !== undefined ? { cause: error.cause } : {}),
      ...(error.target_api ? { target_api: error.target_api } : {}),
    },
  };
};

const isObjectLike = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const chatErrorPayloadFromOpenAIResponsesFailure = (event: Extract<OpenAIResponsesStreamEventEx, { type: 'response.failed' }>): OpenAIChatCompletionsErrorPayload => {
  const response = event.response as OpenAIResponsesResultEx;
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

const chatErrorFrameFromOpenAIResponsesFatalEvent = (event: OpenAIResponsesStreamEventEx): ProtocolFrame<OpenAIChatCompletionsStreamEvent> | undefined => {
  if (event.type === 'error') {
    // OpenAI-compatible Chat Completions streams can carry top-level error payloads;
    // OpenAIChatCompletionsStreamEvent only models successful chunk payloads.
    return eventFrame(chatErrorPayloadFromOpenAIResponsesError(event as Extract<OpenAIResponsesStreamEventEx, { type: 'error' }>) as unknown as OpenAIChatCompletionsStreamEvent);
  }

  if (event.type === 'response.failed') {
    return eventFrame(chatErrorPayloadFromOpenAIResponsesFailure(event as Extract<OpenAIResponsesStreamEventEx, { type: 'response.failed' }>) as unknown as OpenAIChatCompletionsStreamEvent);
  }

  return undefined;
};

export const translateToSourceEvents = async function* (frames: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx>>): AsyncGenerator<ProtocolFrame<OpenAIChatCompletionsStreamEvent>> {
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
