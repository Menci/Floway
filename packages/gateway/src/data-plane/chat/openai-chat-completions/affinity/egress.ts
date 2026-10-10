import type { AffinityEgressOptions } from '../../shared/affinity/index.ts';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import { openaiChatCompletionsErrorPayloadMessage, type OpenAIChatCompletionsAssistantDeltaEx, type OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';

interface ChoiceState {
  opaque?: string;
  finished: boolean;
  usage?: OpenAIChatCompletionsStreamEvent['usage'];
}

interface OpenAIChatCompletionsAffinityEgressOptions extends AffinityEgressOptions {
  continuousUsageStats?: boolean;
}

type StreamingChoice = OpenAIChatCompletionsStreamEvent['choices'][number];
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

export const wrapOpenAIChatCompletionsAffinityEgress = async function* (
  frames: AsyncIterable<ProtocolFrame<OpenAIChatCompletionsStreamEvent>>,
  options: OpenAIChatCompletionsAffinityEgressOptions,
): AsyncGenerator<ProtocolFrame<OpenAIChatCompletionsStreamEvent>> {
  // One choice is one logical assistant element, so its carrier frame before
  // finish_reason (or DONE when finish_reason is absent) is both the turn
  // prefix and final opaque snapshot.
  const choices = new Map<number, ChoiceState>();
  let lastEvent: OpenAIChatCompletionsStreamEvent | undefined;
  let failed = false;
  const projectFrames = (event: OpenAIChatCompletionsStreamEvent, projected: StreamingChoice[], includeOriginalFields: boolean): ProtocolFrame<OpenAIChatCompletionsStreamEvent>[] => {
    if (!options.continuousUsageStats || projected.length === 0) return [eventFrame(eventWithChoices(event, projected, includeOriginalFields))];
    // vLLM counts intermediate output per choice and aggregates only on the trailing usage frame.
    // https://github.com/vllm-project/vllm/blob/d5f0a6e829faa69d1db289bf62b14dae136c02b2/vllm/entrypoints/openai/chat_completion/serving.py#L798-L824
    return projected.map((choice, index) => eventFrame({
      ...eventWithChoices(event, [choice], includeOriginalFields && index === 0),
      usage: choices.get(choice.index)?.usage ?? null,
    }));
  };

  for await (const frame of frames) {
    if (frame.type !== 'event') {
      if (frame.type === 'done' && !failed) {
        const unfinished = [...choices.entries()].filter(([, state]) => !state.finished);
        if (unfinished.length > 0 && lastEvent !== undefined) {
          const wrappedChoices = await Promise.all(unfinished.map(async ([index, state]) => {
            state.finished = true;
            return {
              index,
              delta: { reasoning_opaque: await options.codec.wrap(state.opaque, options.affinity, 'openai-chat-completions.reasoning_opaque') } as OpenAIChatCompletionsAssistantDeltaEx,
              finish_reason: null,
            } satisfies StreamingChoice;
          }));
          for (const projected of projectFrames(lastEvent, wrappedChoices, false)) yield projected;
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
    if (frame.event.choices.length === 0 && frame.event.usage != null && choices.size === 1) {
      choices.values().next().value!.usage = frame.event.usage;
    }

    const visibleChoices: StreamingChoice[] = [];
    const finishingChoices: Array<{
      index: number;
      finishReason: NonNullable<StreamingChoice['finish_reason']>;
      state: ChoiceState;
    }> = [];

    for (const choice of frame.event.choices) {
      const { index, delta: sourceDelta, finish_reason: finishReason, ...choiceExtras } = choice;
      const previous = choices.get(index);
      const state: ChoiceState = previous === undefined || previous.finished ? { finished: false } : previous;
      if (frame.event.usage != null) state.usage = frame.event.usage;
      choices.set(index, state);

      const { reasoning_opaque: opaque, ...delta } = sourceDelta as OpenAIChatCompletionsAssistantDeltaEx;
      if (typeof opaque === 'string') state.opaque = opaque;
      const hasVisibleProjection = Object.keys(delta).length > 0 || Object.keys(choiceExtras).length > 0;

      if (finishReason == null) {
        if (hasVisibleProjection) visibleChoices.push({ index, ...choiceExtras, delta, finish_reason: null } as StreamingChoice);
        continue;
      }

      if (hasVisibleProjection) visibleChoices.push({ index, ...choiceExtras, delta, finish_reason: null } as StreamingChoice);
      finishingChoices.push({ index, finishReason, state });
    }

    if (visibleChoices.length > 0 || frame.event.choices.length === 0 || hasOptionalChunkFields(frame.event)) {
      for (const projected of projectFrames(frame.event, visibleChoices, true)) yield projected;
    }

    if (finishingChoices.length === 0) continue;

    const wrappedChoices = await Promise.all(finishingChoices.map(async ({ index, state }) => ({
      index,
      delta: { reasoning_opaque: await options.codec.wrap(state.opaque, options.affinity, 'openai-chat-completions.reasoning_opaque') } as OpenAIChatCompletionsAssistantDeltaEx,
      finish_reason: null,
    })));
    for (const projected of projectFrames(frame.event, wrappedChoices, false)) yield projected;

    const finishedChoices = finishingChoices.map(({ index, finishReason, state }) => {
      state.finished = true;
      return { index, delta: {}, finish_reason: finishReason };
    });
    for (const projected of projectFrames(frame.event, finishedChoices, false)) yield projected;
  }
};
