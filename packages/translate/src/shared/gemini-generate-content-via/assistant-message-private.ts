import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import { isGeminiGenerateContentTerminalEvent, type GeminiGenerateContentPayload, type GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';
import type { OpenAIChatCompletionsAssistantMessagePrivate, OpenAIChatCompletionsAssistantMessageSidecar, OpenAIChatCompletionsPrivateCodec } from '@floway-dev/protocols/openai-chat-completions';

export const decodeGeminiGenerateContentPrivateHistory = async (payload: GeminiGenerateContentPayload, codec: OpenAIChatCompletionsPrivateCodec): Promise<ReadonlyMap<object, OpenAIChatCompletionsAssistantMessagePrivate>> => {
  const decoded = new Map<object, OpenAIChatCompletionsAssistantMessagePrivate>();
  for (const content of payload.contents ?? []) {
    if (content.role !== 'model') continue;
    for (const part of content.parts ?? []) {
      const value = await codec.unencapsulate(part.thoughtSignature);
      if (value === undefined) continue;
      decoded.set(content, value);
      break;
    }
  }
  return decoded;
};

export const wrapGeminiGenerateContentNativePrivateEvents = async function* <T>(
  frames: AsyncIterable<ProtocolFrame<T>>,
  translate: (frames: AsyncIterable<ProtocolFrame<T>>) => AsyncIterable<ProtocolFrame<GeminiGenerateContentStreamEvent>>,
  observe: (event: T) => string[],
  finalize: () => OpenAIChatCompletionsAssistantMessageSidecar | undefined,
  codec: OpenAIChatCompletionsPrivateCodec,
): AsyncGenerator<ProtocolFrame<GeminiGenerateContentStreamEvent>> {
  let reasoningText: string | undefined;
  const observed = async function* () {
    for await (const frame of frames) {
      if (frame.type === 'event') for (const text of observe(frame.event)) reasoningText = (reasoningText ?? '') + text;
      yield frame;
    }
  };
  for await (const frame of translate(observed())) {
    if (frame.type !== 'event' || 'error' in frame.event || !isGeminiGenerateContentTerminalEvent(frame.event)) { yield frame; continue; }
    const sidecar = finalize();
    if (sidecar === undefined) { yield frame; continue; }
    const thoughtSignature = await codec.encapsulate({ reasoningText, sidecar });
    yield eventFrame({
      ...frame.event, candidates: frame.event.candidates?.map(candidate => ({
        ...candidate,
        content: { ...candidate.content, role: 'model', parts: [...candidate.content?.parts ?? [], { thoughtSignature }] },
      })),
    });
  }
};
