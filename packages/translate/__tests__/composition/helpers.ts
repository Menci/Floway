import type { SourceProtocol, TargetProtocol } from '../../src/composition/index.ts';
import { resolveReading } from '../../src/composition/reading.ts';
import type { SourceReading, RestoredAssistantTurn } from '../../src/composition/reading.ts';
import type { IRInputTurn } from '../../src/ir/input/types.ts';
import { anthropicMessagesSourceProtocol } from '../../src/protocols/anthropic-messages/as-source.ts';
import { anthropicMessagesTargetProtocol } from '../../src/protocols/anthropic-messages/as-target.ts';
import { geminiGenerateContentSourceProtocol } from '../../src/protocols/gemini-generate-content/as-source.ts';
import { openaiChatCompletionsSourceProtocol } from '../../src/protocols/openai-chat-completions/as-source.ts';
import { openaiChatCompletionsTargetProtocol } from '../../src/protocols/openai-chat-completions/as-target.ts';
import { openaiResponsesSourceProtocol } from '../../src/protocols/openai-responses/as-source.ts';
import { openaiResponsesTargetProtocol } from '../../src/protocols/openai-responses/as-target.ts';
import { createRoundTripCoordinator } from '../../src/round-trip/coordinator.ts';
import type { AssistantTurnProtocol, InputAssistantTurnFor } from '../../src/round-trip/input-assistant-turn.ts';
import { roundTripAssistantTurn, type SidecarRecognition } from '../../src/round-trip/resolve.ts';
import type { SourceAssistantTurnFor } from '../../src/round-trip/source-assistant-turn.ts';
import type { TranslateOptions } from '../../src/types.ts';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiGenerateContentRequest } from '@floway-dev/protocols/gemini-generate-content';
import type { OpenAIChatCompletionsPayloadEx } from '@floway-dev/protocols/openai-chat-completions';
import type { OpenAIResponsesRequestPayloadEx } from '@floway-dev/protocols/openai-responses';

export const pairs = {
  messagesToChat: [anthropicMessagesSourceProtocol, openaiChatCompletionsTargetProtocol],
  messagesToResponses: [anthropicMessagesSourceProtocol, openaiResponsesTargetProtocol],
  chatToMessages: [openaiChatCompletionsSourceProtocol, anthropicMessagesTargetProtocol],
  chatToResponses: [openaiChatCompletionsSourceProtocol, openaiResponsesTargetProtocol],
  responsesToMessages: [openaiResponsesSourceProtocol, anthropicMessagesTargetProtocol],
  responsesToChat: [openaiResponsesSourceProtocol, openaiChatCompletionsTargetProtocol],
  geminiToMessages: [geminiGenerateContentSourceProtocol, anthropicMessagesTargetProtocol],
  geminiToChat: [geminiGenerateContentSourceProtocol, openaiChatCompletionsTargetProtocol],
  geminiToResponses: [geminiGenerateContentSourceProtocol, openaiResponsesTargetProtocol],
} as const;

export const emptyPayload = {
  messages: { model: 'm', max_tokens: 16, stream: true, messages: [] } as AnthropicMessagesPayload,
  chat: { model: 'm', stream: true, messages: [] } as OpenAIChatCompletionsPayloadEx,
  responses: { model: 'm', stream: true, input: [] } as OpenAIResponsesRequestPayloadEx,
  gemini: { model: 'model', contents: [] } as GeminiGenerateContentRequest,
};

/**
 * Settles every assistant slot that carries a sidecar this target can restore.
 *
 * A slot whose sidecar was recognised is written natively by the target; one
 * that carries no sidecar for this target falls back to the IR its own thunk
 * builds. The two paths are exclusive, which is why the thunk is only called on
 * the second.
 */
const resolveReadingTurns = async <
  SrcName extends AssistantTurnProtocol,
  TgtName extends AssistantTurnProtocol,
>(
  source: { readonly name: SrcName; readonly sidecarRecognition: SidecarRecognition<SourceAssistantTurnFor<SrcName>> },
  target: { readonly name: TgtName },
  reading: SourceReading<SourceAssistantTurnFor<SrcName>>,
  options: TranslateOptions,
): Promise<(IRInputTurn | RestoredAssistantTurn<InputAssistantTurnFor<TgtName>>)[]> =>
  await resolveReading(reading, turn => roundTripAssistantTurn(
    source.name, target.name, turn.assistantTurn, options.sidecarCodec, source.sidecarRecognition,
  ));

export const buildTargetPayloadFor = async <
  SrcName extends AssistantTurnProtocol, SrcPayload, SrcEvent,
  TgtName extends AssistantTurnProtocol, TgtPayload, TgtEvent, Context,
>(
  source: SourceProtocol<SrcName, SrcPayload, SrcEvent>,
  target: TargetProtocol<TgtName, TgtPayload, TgtEvent, Context>,
  payload: SrcPayload,
  options: TranslateOptions,
  reading: SourceReading<SourceAssistantTurnFor<SrcName>> = source.read(payload),
): Promise<TgtPayload> =>
  target.write(reading.request, await resolveReadingTurns(source, target, reading, options), options).payload;

export const buildSourceEventsFor = <
  SrcName extends AssistantTurnProtocol, SrcPayload, SrcEvent,
  TgtName extends AssistantTurnProtocol, TgtPayload, TgtEvent, Context,
>(
  source: SourceProtocol<SrcName, SrcPayload, SrcEvent>,
  target: TargetProtocol<TgtName, TgtPayload, TgtEvent, Context>,
  payload: SrcPayload,
  options: TranslateOptions,
  frames: AsyncIterable<ProtocolFrame<TgtEvent>>,
): AsyncIterable<ProtocolFrame<SrcEvent>> => {
  const reading = source.read(payload);
  const coordinator = createRoundTripCoordinator(source.name, target.name, options.sidecarCodec);
  // Stating the answer needs what writing the request recorded, so this walks
  // the same writing step the composed trip does.
  return (async function* () {
    const { context } = target.write(reading.request, await resolveReadingTurns(source, target, reading, options), options);
    yield* source.writeEvents(payload, target.readEvents(frames, context, coordinator.reader), coordinator.writer);
  })();
};
