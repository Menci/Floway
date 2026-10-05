import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import { accumulateOpenAIChatCompletionsPrivate, createOpenAIChatCompletionsReasoningCarrierDelta, finalizeOpenAIChatCompletionsPrivate, OpenAIChatCompletionsAssistantMessagePrivate, openaiChatCompletionsErrorPayloadMessage, type OpenAIChatCompletionsAssistantDeltaEx, type OpenAIChatCompletionsPrivateContext, type OpenAIChatCompletionsPrivateDraft, type OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import type { ExecuteResult } from '@floway-dev/provider';

export const OpenAIChatCompletionsPrivateResponse = Symbol('OpenAIChatCompletionsPrivateResponse');
export type OpenAIChatCompletionsPrivateResponse = Extract<ExecuteResult<ProtocolFrame<OpenAIChatCompletionsStreamEvent>>, { type: 'events' }> & {
  [OpenAIChatCompletionsPrivateResponse]: OpenAIChatCompletionsPrivateContext;
};

type Choice = OpenAIChatCompletionsStreamEvent['choices'][number];
interface ChoiceState { private: OpenAIChatCompletionsPrivateDraft; finishReason?: NonNullable<Choice['finish_reason']> }

const readableDelta = (text: string, context: OpenAIChatCompletionsPrivateContext): OpenAIChatCompletionsAssistantDeltaEx => ({
  [context.preference.textFieldName]: text,
  ...(context.preference.reasoningEncapsulationFormat === 'openrouter-reasoning_details'
    ? { reasoning_details: [{ type: 'reasoning.summary', summary: text, format: 'unknown', index: 0 }] } : {}),
});

const carrierEvent = (basis: OpenAIChatCompletionsStreamEvent, choices: Choice[]): OpenAIChatCompletionsStreamEvent => {
  const { id, object, model, created } = basis;
  return { id, object, model, created, choices };
};

export const encodeOpenAIChatCompletionsPrivate = async function* (
  frames: AsyncIterable<ProtocolFrame<OpenAIChatCompletionsStreamEvent>>,
  context: OpenAIChatCompletionsPrivateContext | undefined,
): AsyncGenerator<ProtocolFrame<OpenAIChatCompletionsStreamEvent>> {
  if (context === undefined) { yield* frames; return; }
  const states = new Map<number, ChoiceState>();
  let basis: OpenAIChatCompletionsStreamEvent | undefined;
  let done: ProtocolFrame<OpenAIChatCompletionsStreamEvent> | undefined;
  let failed = false;
  for await (const frame of frames) {
    if (frame.type === 'done') { done = frame; break; }
    if (openaiChatCompletionsErrorPayloadMessage(frame.event) !== null) { failed = true; yield frame; continue; }
    basis = frame.event;
    const choices: Choice[] = [];
    for (const choice of frame.event.choices) {
      const state = states.get(choice.index) ?? { private: {} };
      states.set(choice.index, state);
      const { [OpenAIChatCompletionsAssistantMessagePrivate]: value, ...delta } = choice.delta as OpenAIChatCompletionsAssistantDeltaEx;
      if (value !== undefined) {
        accumulateOpenAIChatCompletionsPrivate(state.private, value);
        if (value.reasoningText !== undefined) Object.assign(delta, readableDelta(value.reasoningText, context));
      }
      if (choice.finish_reason != null) state.finishReason = choice.finish_reason;
      if (Object.keys(delta).length > 0 || Object.keys(choice).some(field => field !== 'index' && field !== 'delta' && field !== 'finish_reason')) choices.push({ ...choice, delta, finish_reason: null });
    }
    const hasExtras = Object.keys(frame.event).some(field => !['id', 'object', 'created', 'model', 'choices'].includes(field));
    if (choices.length > 0 || frame.event.choices.length === 0 || hasExtras) yield eventFrame({ ...frame.event, choices });
  }
  if (basis !== undefined && !failed) {
    const carriers: Choice[] = [];
    const finishes: Choice[] = [];
    for (const [index, state] of states) {
      const value = finalizeOpenAIChatCompletionsPrivate(state.private);
      if (value !== undefined) {
        const data = await context.codec.encapsulate({ sidecar: value.sidecar });
        carriers.push({ index, delta: createOpenAIChatCompletionsReasoningCarrierDelta(data, context.preference), finish_reason: null });
      }
      if (state.finishReason !== undefined) finishes.push({ index, delta: {}, finish_reason: state.finishReason });
    }
    if (carriers.length > 0) yield eventFrame(carrierEvent(basis, carriers));
    if (finishes.length > 0) yield eventFrame(carrierEvent(basis, finishes));
  }
  if (done !== undefined) yield done;
};
