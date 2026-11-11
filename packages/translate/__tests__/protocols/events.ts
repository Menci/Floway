import type { IRRecord } from '../../src/ir/output/records.ts';
import { writeAnthropicMessagesEvents as anthropicMessagesFromIRProduction } from '../../src/protocols/anthropic-messages/as-source/events.ts';
import { readAnthropicMessagesEvents as irFromAnthropicMessagesProduction } from '../../src/protocols/anthropic-messages/as-target/events.ts';
import { writeGeminiGenerateContentEvents as geminiGenerateContentFromIRProduction } from '../../src/protocols/gemini-generate-content/as-source/events.ts';
import { writeOpenAIChatCompletionsEvents as openaiChatCompletionsFromIRProduction } from '../../src/protocols/openai-chat-completions/as-source/events.ts';
import { readOpenAIChatCompletionsEvents as irFromOpenAIChatCompletionsProduction } from '../../src/protocols/openai-chat-completions/as-target/events.ts';
import { writeOpenAIResponsesEvents as openaiResponsesFromIRProduction } from '../../src/protocols/openai-responses/as-source/events.ts';
import { readOpenAIResponsesEvents as irFromOpenAIResponsesProduction } from '../../src/protocols/openai-responses/as-target/events.ts';
import type { RoundTripReader } from '../../src/round-trip/reader.ts';
import { createReferenceBuilder } from '../../src/round-trip/reference/reference-builder.ts';
import type { RoundTripWriter } from '../../src/round-trip/writer.ts';

const reader = <Protocol extends 'anthropicMessages' | 'openaiChatCompletions' | 'openaiResponses'>(): RoundTripReader<Protocol> => ({
  builder: createReferenceBuilder(),
  onAssistantTurn: () => {},
});
const writer = <Protocol extends 'anthropicMessages' | 'geminiGenerateContent' | 'openaiChatCompletions' | 'openaiResponses'>(): RoundTripWriter<Protocol> => ({
  builder: createReferenceBuilder(),
  encodeSidecar: async () => 'test-sidecar',
});

// These ordinary output IR fixtures use independent mock participants. Provenance is
// exercised by the native-reader and public-route tests sharing one coordinator.
const withoutProvenance = async function* (records: AsyncIterable<IRRecord>): AsyncGenerator<IRRecord> {
  for await (const record of records) {
    if (record.type === 'write' && record.kind === 'append') {
      const { textFragmentIds: _referencePieceIds, ...operation } = record;
      yield operation;
    } else yield record;
  }
};

export const readAnthropicMessagesEvents = (frames: Parameters<typeof irFromAnthropicMessagesProduction>[0], options: Omit<Parameters<typeof irFromAnthropicMessagesProduction>[1], 'roundTrip'> = {}) =>
  withoutProvenance(irFromAnthropicMessagesProduction(frames, { ...options, roundTrip: reader<'anthropicMessages'>() }));
export const readOpenAIChatCompletionsEvents = (frames: Parameters<typeof irFromOpenAIChatCompletionsProduction>[0], options: Omit<Parameters<typeof irFromOpenAIChatCompletionsProduction>[1], 'roundTrip'> = {}) =>
  withoutProvenance(irFromOpenAIChatCompletionsProduction(frames, { ...options, roundTrip: reader<'openaiChatCompletions'>() }));
export const readOpenAIResponsesEvents = (
  frames: Parameters<typeof irFromOpenAIResponsesProduction>[0],
  roundTrip: RoundTripReader<'openaiResponses'> = reader<'openaiResponses'>(),
) => withoutProvenance(irFromOpenAIResponsesProduction(frames, { roundTrip }));
export const writeAnthropicMessagesEvents = (records: Parameters<typeof anthropicMessagesFromIRProduction>[0], options: Omit<Parameters<typeof anthropicMessagesFromIRProduction>[1], 'roundTrip'> = {}) =>
  anthropicMessagesFromIRProduction(records, { ...options, roundTrip: writer<'anthropicMessages'>() });
export const writeOpenAIChatCompletionsEvents = (records: Parameters<typeof openaiChatCompletionsFromIRProduction>[0], options: Omit<Parameters<typeof openaiChatCompletionsFromIRProduction>[1], 'roundTrip'> = {}) =>
  openaiChatCompletionsFromIRProduction(records, { ...options, roundTrip: writer<'openaiChatCompletions'>() });
export const writeOpenAIResponsesEvents = (records: Parameters<typeof openaiResponsesFromIRProduction>[0], options: Omit<Parameters<typeof openaiResponsesFromIRProduction>[1], 'roundTrip'> = {}) =>
  openaiResponsesFromIRProduction(records, { ...options, roundTrip: writer<'openaiResponses'>() });
export const writeGeminiGenerateContentEvents = (records: Parameters<typeof geminiGenerateContentFromIRProduction>[0], options: Omit<Parameters<typeof geminiGenerateContentFromIRProduction>[1], 'roundTrip'> = {}) =>
  geminiGenerateContentFromIRProduction(records, { ...options, roundTrip: writer<'geminiGenerateContent'>() });
