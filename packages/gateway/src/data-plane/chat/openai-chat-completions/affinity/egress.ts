import { chatAffinityCarriers, OPENAI_CHAT_COMPLETIONS_AFFINITY_DOMAIN, replaceChatAffinityCarriers } from './carriers.ts';
import type { AffinityEgressOptions } from '../../shared/affinity/index.ts';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import { createOpenAIChatCompletionsReasoningCarrierDelta, openaiChatCompletionsErrorPayloadMessage, type OpenAIChatCompletionsAssistantDeltaEx, type OpenAIChatCompletionsReasoningPreference, type OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';

export interface ChatAffinityEgressOptions extends AffinityEgressOptions { preference: OpenAIChatCompletionsReasoningPreference }

export const wrapOpenAIChatCompletionsAffinityEgress = async function* (
  frames: AsyncIterable<ProtocolFrame<OpenAIChatCompletionsStreamEvent>>,
  options: ChatAffinityEgressOptions,
): AsyncGenerator<ProtocolFrame<OpenAIChatCompletionsStreamEvent>> {
  const missing = new Set<number>();
  const satisfied = new Set<number>();
  let basis: OpenAIChatCompletionsStreamEvent | undefined;
  let failed = false;
  const synthetic = async (indexes: number[]): Promise<OpenAIChatCompletionsStreamEvent> => {
    if (basis === undefined) throw new Error('Affinity carrier has no source event');
    const choices = await Promise.all(indexes.map(async index => {
      missing.delete(index);
      satisfied.add(index);
      return { index, delta: createOpenAIChatCompletionsReasoningCarrierDelta(await options.codec.wrap(undefined, options.affinity, OPENAI_CHAT_COMPLETIONS_AFFINITY_DOMAIN), options.preference), finish_reason: null };
    }));
    const { id, object, model, created } = basis;
    return { id, object, model, created, choices };
  };
  for await (const frame of frames) {
    if (frame.type === 'done') {
      if (!failed && missing.size > 0) yield eventFrame(await synthetic([...missing]));
      yield frame;
      return;
    }
    if (openaiChatCompletionsErrorPayloadMessage(frame.event) !== null) { failed = true; yield frame; continue; }
    basis = frame.event;
    const choices = await Promise.all(frame.event.choices.map(async choice => {
      if (!satisfied.has(choice.index)) missing.add(choice.index);
      const carriers = chatAffinityCarriers(choice.delta as OpenAIChatCompletionsAssistantDeltaEx, options.preference);
      if (carriers.length === 0) return choice;
      const replacements = await Promise.all(carriers.map(async carrier => ({ carrier, value: await options.codec.wrap(carrier.value, options.affinity, OPENAI_CHAT_COMPLETIONS_AFFINITY_DOMAIN) })));
      missing.delete(choice.index);
      satisfied.add(choice.index);
      return { ...choice, delta: replaceChatAffinityCarriers(choice.delta as OpenAIChatCompletionsAssistantDeltaEx, replacements) };
    }));
    const finishing = choices.filter(choice => choice.finish_reason != null && missing.has(choice.index));
    if (finishing.length > 0) {
      const pending = new Set(finishing.map(choice => choice.index));
      const visible = choices.map(choice => pending.has(choice.index) ? { ...choice, finish_reason: null } : choice);
      yield eventFrame({ ...frame.event, choices: visible });
      yield eventFrame(await synthetic([...pending]));
      const { id, object, model, created } = frame.event;
      yield eventFrame({ id, object, model, created, choices: finishing.map(choice => ({ index: choice.index, delta: {}, finish_reason: choice.finish_reason })) });
    } else yield choices.every((choice, index) => choice === frame.event.choices[index]) ? frame : eventFrame({ ...frame.event, choices });
  }
  if (!failed && missing.size > 0) yield eventFrame(await synthetic([...missing]));
};
