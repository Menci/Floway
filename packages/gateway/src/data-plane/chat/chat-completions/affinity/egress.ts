import { CHAT_COMPLETIONS_AFFINITY_DOMAIN } from './domain.ts';
import type { AffinityEgressOptions } from '../../shared/affinity/egress-options.ts';
import { chatCompletionsErrorPayloadMessage, type ChatCompletionsDelta, type ChatCompletionsStreamEvent } from '@floway-dev/protocols/chat-completions';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';

interface ChoiceState {
  opaque?: string;
  finished: boolean;
}

type StreamingChoice = ChatCompletionsStreamEvent['choices'][number];

const withoutOpaque = (delta: ChatCompletionsDelta): ChatCompletionsDelta => {
  const { reasoning_opaque: _opaque, ...visible } = delta;
  return visible;
};

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
              delta: { reasoning_opaque: await options.codec.wrap(state.opaque, options.affinity, CHAT_COMPLETIONS_AFFINITY_DOMAIN) },
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
    const finishingChoices: Array<{ choice: StreamingChoice; state: ChoiceState }> = [];

    for (const choice of frame.event.choices) {
      const state = choices.get(choice.index) ?? { finished: false };
      if (state.finished) throw new Error(`Chat Completions choice ${choice.index} emitted data after its finish_reason`);
      choices.set(choice.index, state);

      if (typeof choice.delta.reasoning_opaque === 'string') state.opaque = choice.delta.reasoning_opaque;
      const delta = withoutOpaque(choice.delta);

      if (choice.finish_reason === null) {
        if (Object.keys(delta).length > 0) visibleChoices.push({ ...choice, delta });
        continue;
      }

      if (Object.keys(delta).length > 0) {
        visibleChoices.push({ ...choice, delta, finish_reason: null });
      }
      finishingChoices.push({ choice, state });
    }

    if (visibleChoices.length > 0 || frame.event.choices.length === 0) {
      yield eventFrame(eventWithChoices(frame.event, visibleChoices, finishingChoices.length === 0));
    }

    if (finishingChoices.length === 0) continue;

    const wrappedChoices = await Promise.all(finishingChoices.map(async ({ choice, state }) => ({
      ...choice,
      delta: { reasoning_opaque: await options.codec.wrap(state.opaque, options.affinity, CHAT_COMPLETIONS_AFFINITY_DOMAIN) },
      finish_reason: null,
    })));
    yield eventFrame(eventWithChoices(frame.event, wrappedChoices, false));

    const finishedChoices = finishingChoices.map(({ choice, state }) => {
      state.finished = true;
      return { ...choice, delta: {}, finish_reason: choice.finish_reason };
    });
    yield eventFrame(eventWithChoices(frame.event, finishedChoices, true));
  }
};
