import type { AffinityEgressOptions } from '../../shared/affinity/index.ts';
import { chatCompletionsErrorPayloadMessage, type ChatCompletionsStreamEvent } from '@floway-dev/protocols/chat-completions';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';

interface ChoiceState {
  opaque?: string;
  finished: boolean;
}

type StreamingChoice = ChatCompletionsStreamEvent['choices'][number];

const eventWithChoices = (
  event: ChatCompletionsStreamEvent,
  choices: StreamingChoice[],
  includeUsage: boolean,
): ChatCompletionsStreamEvent => {
  if (includeUsage || event.usage === undefined) return { ...event, choices };
  const { usage: _usage, ...rest } = event;
  return { ...rest, choices };
};

export const wrapChatCompletionsAffinityEgress = async function* (
  frames: AsyncIterable<ProtocolFrame<ChatCompletionsStreamEvent>>,
  options: AffinityEgressOptions,
): AsyncGenerator<ProtocolFrame<ChatCompletionsStreamEvent>> {
  // One choice is one logical assistant element, so its physical carrier frame
  // immediately before finish is both the turn prefix and final opaque snapshot.
  const choices = new Map<number, ChoiceState>();
  let lastEvent: ChatCompletionsStreamEvent | undefined;
  let failed = false;

  for await (const frame of frames) {
    if (frame.type !== 'event') {
      if (frame.type === 'done' && !failed) {
        if (choices.size === 0 || lastEvent === undefined) {
          throw new Error('Chat Completions stream ended without an assistant choice');
        }
        const unfinished = [...choices.entries()].filter(([, state]) => !state.finished);
        if (unfinished.length > 0) {
          const wrappedChoices = await Promise.all(unfinished.map(async ([index, state]) => {
            state.finished = true;
            return {
              index,
              delta: { reasoning_opaque: await options.codec.wrap(state.opaque, options.affinity, 'chat-completions.reasoning_opaque') },
              finish_reason: null,
            } satisfies StreamingChoice;
          }));
          yield eventFrame(eventWithChoices(lastEvent, wrappedChoices, false));
        }
      }
      yield frame;
      continue;
    }

    if (chatCompletionsErrorPayloadMessage(frame.event) !== null) {
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
      const state = choices.get(index) ?? { finished: false };
      if (state.finished) throw new Error(`Chat Completions choice ${index} emitted data after its finish_reason`);
      choices.set(index, state);

      const { reasoning_opaque: opaque, ...delta } = sourceDelta;
      if (typeof opaque === 'string') state.opaque = opaque;
      const hasVisibleProjection = Object.keys(delta).length > 0 || Object.keys(choiceExtras).length > 0;

      if (finishReason === null) {
        if (hasVisibleProjection) visibleChoices.push({ index, ...choiceExtras, delta, finish_reason: null } as StreamingChoice);
        continue;
      }

      if (hasVisibleProjection) visibleChoices.push({ index, ...choiceExtras, delta, finish_reason: null } as StreamingChoice);
      finishingChoices.push({ index, finishReason, state });
    }

    if (visibleChoices.length > 0 || frame.event.choices.length === 0) {
      yield eventFrame(eventWithChoices(frame.event, visibleChoices, finishingChoices.length === 0));
    }

    if (finishingChoices.length === 0) continue;

    const wrappedChoices = await Promise.all(finishingChoices.map(async ({ index, state }) => ({
      index,
      delta: { reasoning_opaque: await options.codec.wrap(state.opaque, options.affinity, 'chat-completions.reasoning_opaque') },
      finish_reason: null,
    })));
    yield eventFrame(eventWithChoices(frame.event, wrappedChoices, false));

    const finishedChoices = finishingChoices.map(({ index, finishReason, state }) => {
      state.finished = true;
      return { index, delta: {}, finish_reason: finishReason };
    });
    yield eventFrame(eventWithChoices(frame.event, finishedChoices, true));
  }
};
