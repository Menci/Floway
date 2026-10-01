import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import { openaiChatCompletionsErrorPayloadMessage, toFlowayOpenAIChatCompletionsReasoning, fromFlowayOpenAIChatCompletionsReasoning, FlowayOpenAIChatCompletionsReasoning, type ChatCompletionsReasoningFormat, type ReasoningConversionWarning, type OpenAIChatCompletionsPayload, type OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';

export const DOWNSTREAM_CHAT_COMPLETIONS_REASONING: ChatCompletionsReasoningFormat = { text: 'reasoning', data: 'reasoning-opaque' };
export const warnReasoningConversion = (warning: ReasoningConversionWarning): void => {
  console.warn('Floway Chat Completions reasoning format:', warning);
};

export const decodeChatCompletionsHistory = (payload: OpenAIChatCompletionsPayload): OpenAIChatCompletionsPayload => ({
  ...payload,
  messages: payload.messages.map(message => toFlowayOpenAIChatCompletionsReasoning(message, DOWNSTREAM_CHAT_COMPLETIONS_REASONING, { warn: warnReasoningConversion })),
});

export const decodeChatCompletionsFrames = async function* (
  frames: AsyncIterable<ProtocolFrame<OpenAIChatCompletionsStreamEvent>>,
  format: ChatCompletionsReasoningFormat,
  capture?: (frame: ProtocolFrame<OpenAIChatCompletionsStreamEvent>) => void,
): AsyncGenerator<ProtocolFrame<OpenAIChatCompletionsStreamEvent>> {
  const opaqueByChoice = new Map<number, string>();
  for await (const frame of frames) {
    capture?.(frame);
    if (frame.type !== 'event' || openaiChatCompletionsErrorPayloadMessage(frame.event) !== null) { yield frame; continue; }
    yield eventFrame({
      ...frame.event, choices: frame.event.choices.map(choice => {
        const delta = toFlowayOpenAIChatCompletionsReasoning(choice.delta, format, { warn: warnReasoningConversion, stream: { previousOpaque: opaqueByChoice.get(choice.index) ?? '' } });
        const opaque = delta[FlowayOpenAIChatCompletionsReasoning]?.reasoning_opaque;
        if (opaque !== undefined && opaque !== '') opaqueByChoice.set(choice.index, opaque);
        return { ...choice, delta };
      }),
    });
  }
};

export const encodeChatCompletionsFrames = async function* (
  frames: AsyncIterable<ProtocolFrame<OpenAIChatCompletionsStreamEvent>>,
): AsyncGenerator<ProtocolFrame<OpenAIChatCompletionsStreamEvent>> {
  for await (const frame of frames) {
    yield frame.type === 'event' && openaiChatCompletionsErrorPayloadMessage(frame.event) === null ? eventFrame({ ...frame.event, choices: frame.event.choices.map(choice => ({ ...choice, delta: fromFlowayOpenAIChatCompletionsReasoning(choice.delta, DOWNSTREAM_CHAT_COMPLETIONS_REASONING, { warn: warnReasoningConversion }) })) }) : frame;
  }
};
