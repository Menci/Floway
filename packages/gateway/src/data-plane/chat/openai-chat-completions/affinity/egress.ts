import type { AffinityEgressOptions } from '../../shared/affinity/index.ts';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import { openaiChatCompletionsErrorPayloadMessage, type OpenAIChatCompletionsAssistantDeltaEx, type OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';

const REASONING_OPAQUE_DOMAIN = 'openai-chat-completions.reasoning_opaque';
const ENCRYPTED_REASONING_DETAILS_DOMAIN = 'openai-chat-completions.reasoning_details.reasoning.encrypted.data';

interface ChoiceState {
  opaque?: string;
  finished: boolean;
}

type StreamingChoice = OpenAIChatCompletionsStreamEvent['choices'][number];
type StreamingDelta = OpenAIChatCompletionsStreamEvent['choices'][number]['delta'];
const REQUIRED_CHUNK_KEYS = new Set(['id', 'object', 'created', 'model', 'choices']);

const eventWithChoices = (
  event: OpenAIChatCompletionsStreamEvent,
  choices: StreamingChoice[],
  includeOriginalFields: boolean,
): OpenAIChatCompletionsStreamEvent => {
  const { id, object, created, model, choices: _choices, ...optional } = event;
  return {
    id,
    object,
    created,
    model,
    choices,
    ...(includeOriginalFields ? optional : {}),
  };
};

const hasOptionalChunkFields = (event: OpenAIChatCompletionsStreamEvent): boolean =>
  Object.keys(event).some(key => !REQUIRED_CHUNK_KEYS.has(key));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const wrapReasoningDetails = async (
  details: unknown,
  options: AffinityEgressOptions,
): Promise<unknown> => {
  if (!Array.isArray(details)) return details;
  let changed = false;
  const wrapped = await Promise.all(details.map(async detail => {
    if (!isRecord(detail) || detail.type !== 'reasoning.encrypted' || typeof detail.data !== 'string' || detail.data.length === 0) return detail;
    changed = true;
    return {
      ...detail,
      data: await options.codec.wrap(detail.data, options.affinity, ENCRYPTED_REASONING_DETAILS_DOMAIN),
    };
  }));
  return changed ? wrapped : details;
};

const projectDelta = async (
  delta: StreamingDelta,
  options: AffinityEgressOptions,
): Promise<{ delta: StreamingDelta; opaque?: string }> => {
  const assistantDelta = delta as OpenAIChatCompletionsAssistantDeltaEx;
  const { reasoning_opaque: opaque, ...visibleDelta } = assistantDelta;
  const wrappedReasoningDetails = await wrapReasoningDetails(assistantDelta.reasoning_details, options);
  return {
    delta: wrappedReasoningDetails === assistantDelta.reasoning_details
      ? visibleDelta
      : { ...visibleDelta, reasoning_details: wrappedReasoningDetails } as OpenAIChatCompletionsAssistantDeltaEx,
    ...(typeof opaque === 'string' ? { opaque } : {}),
  };
};

const wrapOpaque = async (opaque: string, options: AffinityEgressOptions): Promise<string> =>
  opaque.length === 0
    ? opaque
    : await options.codec.wrap(opaque, options.affinity, REASONING_OPAQUE_DOMAIN);

export const wrapOpenAIChatCompletionsAffinityEgress = async function* (
  frames: AsyncIterable<ProtocolFrame<OpenAIChatCompletionsStreamEvent>>,
  options: AffinityEgressOptions,
): AsyncGenerator<ProtocolFrame<OpenAIChatCompletionsStreamEvent>> {
  const choices = new Map<number, ChoiceState>();
  let lastEvent: OpenAIChatCompletionsStreamEvent | undefined;
  let failed = false;

  for await (const frame of frames) {
    if (frame.type !== 'event') {
      if (frame.type === 'done' && !failed) {
        const unfinished = [...choices.entries()].filter(([, state]) => !state.finished && state.opaque !== undefined);
        if (unfinished.length > 0 && lastEvent !== undefined) {
          const wrappedChoices = await Promise.all(unfinished.map(async ([index, state]) => {
            state.finished = true;
            return {
              index,
              delta: { reasoning_opaque: await wrapOpaque(state.opaque!, options) } as OpenAIChatCompletionsAssistantDeltaEx,
              finish_reason: null,
            } satisfies StreamingChoice;
          }));
          yield eventFrame(eventWithChoices(lastEvent, wrappedChoices, false));
        }
      }
      yield frame;
      continue;
    }

    if (openaiChatCompletionsErrorPayloadMessage(frame.event) !== null) {
      failed = true;
      yield frame;
      continue;
    }
    lastEvent = frame.event;

    const visibleChoices: StreamingChoice[] = [];
    const finishingChoices: Array<{
      index: number;
      finishReason: NonNullable<StreamingChoice['finish_reason']>;
      state: ChoiceState;
    }> = [];

    for (const choice of frame.event.choices) {
      const { index, delta: sourceDelta, finish_reason: finishReason, ...choiceExtras } = choice;
      const previous = choices.get(index);
      const state = previous === undefined || previous.finished ? { finished: false } : previous;
      choices.set(index, state);

      const projected = await projectDelta(sourceDelta, options);
      if (projected.opaque !== undefined) state.opaque = projected.opaque;
      const delta = projected.delta;
      const hasVisibleProjection = Object.keys(delta).length > 0 || Object.keys(choiceExtras).length > 0;

      if (finishReason == null) {
        if (hasVisibleProjection) visibleChoices.push({ index, ...choiceExtras, delta, finish_reason: null } as StreamingChoice);
        continue;
      }

      if (state.opaque === undefined) {
        state.finished = true;
        visibleChoices.push({ index, ...choiceExtras, delta, finish_reason: finishReason } as StreamingChoice);
        continue;
      }

      if (hasVisibleProjection) visibleChoices.push({ index, ...choiceExtras, delta, finish_reason: null } as StreamingChoice);
      finishingChoices.push({ index, finishReason, state });
    }

    if (visibleChoices.length > 0 || frame.event.choices.length === 0 || hasOptionalChunkFields(frame.event)) {
      yield eventFrame(eventWithChoices(frame.event, visibleChoices, true));
    }

    if (finishingChoices.length === 0) continue;

    const wrappedChoices = await Promise.all(finishingChoices.map(async ({ index, state }) => ({
      index,
      delta: { reasoning_opaque: await wrapOpaque(state.opaque!, options) } as OpenAIChatCompletionsAssistantDeltaEx,
      finish_reason: null,
    })));
    yield eventFrame(eventWithChoices(frame.event, wrappedChoices, false));

    const finishedChoices = finishingChoices.map(({ index, finishReason, state }) => {
      state.finished = true;
      return { index, delta: {}, finish_reason: finishReason };
    });
    yield eventFrame(eventWithChoices(frame.event, finishedChoices, false));
  }
};
