import { reasoningAffinitySlots, wrapChatCompletionsReasoningAffinity } from './reasoning.ts';
import { asJsonObject } from '../../../../shared/json-helpers.ts';
import type { AffinityEgressOptions } from '../../shared/affinity/index.ts';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import { mergeReasoningStreamItems, type ReasoningRecord, type ChatCompletionsReasoningDataStandard, openaiChatCompletionsErrorPayloadMessage, type OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';

interface ChoiceState {
  data: Record<string, unknown>;
  finished: boolean;
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

const carrierDelta = (data: Record<string, unknown>): Record<string, unknown> => {
  const delta: Record<string, unknown> = {};
  const slots = reasoningAffinitySlots(data);
  if (typeof data.reasoning_opaque === 'string') delta.reasoning_opaque = data.reasoning_opaque;
  for (const field of ['reasoning_details', 'thinking_blocks'] as const) {
    const members = data[field];
    if (!Array.isArray(members)) continue;
    const indices = new Set(slots.filter(slot => slot.field === field).map(slot => slot.index));
    delta[field] = members.flatMap((item: ReasoningRecord, index) => {
      if (!indices.has(index)) return [];
      if (field === 'reasoning_details' && item.type === 'reasoning.text') {
        const { text: _text, ...signed } = item;
        return [signed];
      }
      return [item];
    });
  }
  return delta;
};

export const wrapOpenAIChatCompletionsAffinityEgress = async function* (
  frames: AsyncIterable<ProtocolFrame<OpenAIChatCompletionsStreamEvent>>,
  options: AffinityEgressOptions,
  format: Exclude<ChatCompletionsReasoningDataStandard, 'passthrough'> = 'reasoning-opaque',
): AsyncGenerator<ProtocolFrame<OpenAIChatCompletionsStreamEvent>> {
  // One choice is one logical assistant element, so its carrier frame before
  // finish_reason (or DONE when finish_reason is absent) is both the turn
  // prefix and final opaque snapshot.
  const choices = new Map<number, ChoiceState>();
  let lastEvent: OpenAIChatCompletionsStreamEvent | undefined;
  let failed = false;

  for await (const frame of frames) {
    if (frame.type !== 'event') {
      if (frame.type === 'done' && !failed) {
        const unfinished = [...choices.entries()].filter(([, state]) => !state.finished);
        if (unfinished.length > 0 && lastEvent !== undefined) {
          const wrappedChoices = await Promise.all(unfinished.map(async ([index, state]) => {
            state.finished = true;
            return {
              index,
              delta: await wrapChatCompletionsReasoningAffinity(carrierDelta(state.data), options, format),
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
      const state = previous === undefined || previous.finished ? { finished: false, data: {} } : previous;
      choices.set(index, state);

      const delta = { ...sourceDelta };
      const { reasoning_opaque, reasoning_details, thinking_blocks } = sourceDelta;
      if (typeof reasoning_opaque === 'string' && reasoning_opaque !== '') {
        state.data.reasoning_opaque = reasoning_opaque;
        delete delta.reasoning_opaque;
      }
      for (const [field, incoming, standard] of [
        ['reasoning_details', reasoning_details, 'openrouter-reasoning-details'],
        ['thinking_blocks', thinking_blocks, 'litellm-thinking-blocks'],
      ] as const) {
        if (!Array.isArray(incoming) || incoming.length === 0) continue;
        delete delta[field];
        const records = incoming.flatMap(item => {
          const value = asJsonObject(item);
          return value === null ? [] : [value];
        });
        state.data[field] = mergeReasoningStreamItems(state.data[field] as ReasoningRecord[] | undefined ?? [], records, standard);
        const readable = incoming.flatMap(item => {
          if (reasoningAffinitySlots({ [field]: [item] }).length === 0) return [item];
          if (item.type === 'reasoning.encrypted' || item.type === 'redacted_thinking') return [];
          const { signature: _signature, ...visible } = item;
          if ((item.type === 'reasoning.text' && !item.text) || (item.type === 'thinking' && !item.thinking)) return [];
          return [visible];
        });
        if (readable.length > 0) Object.assign(delta, { [field]: readable });
      }
      const hasVisibleProjection = Object.keys(delta).length > 0 || Object.keys(choiceExtras).length > 0;

      if (finishReason === null) {
        if (hasVisibleProjection) visibleChoices.push({ index, ...choiceExtras, delta, finish_reason: null } as StreamingChoice);
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
      delta: await wrapChatCompletionsReasoningAffinity(carrierDelta(state.data), options, format),
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
