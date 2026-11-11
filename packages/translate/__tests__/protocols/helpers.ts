import type { IRRecord } from '../../src/ir/output/records.ts';
import { writeAnthropicMessagesEvents as writeAnthropicMessagesEventsProduction } from '../../src/protocols/anthropic-messages/as-source/events.ts';
import { readAnthropicMessagesEvents as readAnthropicMessagesEventsProduction } from '../../src/protocols/anthropic-messages/as-target/events.ts';
import { writeGeminiGenerateContentEvents as writeGeminiGenerateContentEventsProduction } from '../../src/protocols/gemini-generate-content/as-source/events.ts';
import { writeOpenAIChatCompletionsEvents as writeOpenAIChatCompletionsEventsProduction } from '../../src/protocols/openai-chat-completions/as-source/events.ts';
import { readOpenAIChatCompletionsEvents as readOpenAIChatCompletionsEventsProduction } from '../../src/protocols/openai-chat-completions/as-target/events.ts';
import { writeOpenAIResponsesEvents as writeOpenAIResponsesEventsProduction } from '../../src/protocols/openai-responses/as-source/events.ts';
import { flattenNamespaceTools } from '../../src/protocols/openai-responses/as-source/namespace-tools.ts';
import { readOpenAIResponsesEvents as readOpenAIResponsesEventsProduction } from '../../src/protocols/openai-responses/as-target/events.ts';
import { createReferenceBuilder } from '../../src/round-trip/reference/reference-builder.ts';
import type { RoundTripReader, RoundTripWriter } from '../../src/round-trip/stream.ts';

const reader = <Protocol extends 'anthropicMessages' | 'openaiChatCompletions' | 'openaiResponses'>(): RoundTripReader<Protocol> => ({
  builder: createReferenceBuilder(),
  onAssistantTurn: () => {},
});
const writer = <Protocol extends 'anthropicMessages' | 'geminiGenerateContent' | 'openaiChatCompletions' | 'openaiResponses'>(): RoundTripWriter<Protocol> => ({
  builder: createReferenceBuilder(),
  prepareSidecar: async () => 'test-sidecar',
});
const namespaceToolNames = flattenNamespaceTools({ model: 'test', input: [], tools: [] }).names;

// These ordinary IR fixtures use independent mock participants. Provenance is
// exercised by the native-reader and public-route tests sharing one coordinator.
const withoutProvenance = async function* (records: AsyncIterable<IRRecord>): AsyncGenerator<IRRecord> {
  for await (const record of records) {
    if (record.type === 'write' && record.kind === 'append') {
      const { referencePieceIds: _referencePieceIds, ...operation } = record;
      yield operation;
    } else yield record;
  }
};

export const readAnthropicMessagesEvents = (frames: Parameters<typeof readAnthropicMessagesEventsProduction>[0], options: Omit<Parameters<typeof readAnthropicMessagesEventsProduction>[1], 'roundTrip'> = {}) =>
  withoutProvenance(readAnthropicMessagesEventsProduction(frames, { ...options, roundTrip: reader<'anthropicMessages'>() }));
export const readOpenAIChatCompletionsEvents = (frames: Parameters<typeof readOpenAIChatCompletionsEventsProduction>[0], options: Omit<Parameters<typeof readOpenAIChatCompletionsEventsProduction>[1], 'roundTrip'> = {}) =>
  withoutProvenance(readOpenAIChatCompletionsEventsProduction(frames, { ...options, roundTrip: reader<'openaiChatCompletions'>() }));
export const readOpenAIResponsesEvents = (
  frames: Parameters<typeof readOpenAIResponsesEventsProduction>[0],
  roundTrip: RoundTripReader<'openaiResponses'> = reader<'openaiResponses'>(),
) => withoutProvenance(readOpenAIResponsesEventsProduction(frames, { roundTrip }));
export const writeAnthropicMessagesEvents = (records: Parameters<typeof writeAnthropicMessagesEventsProduction>[0], options: Omit<Parameters<typeof writeAnthropicMessagesEventsProduction>[1], 'roundTrip'> = {}) =>
  writeAnthropicMessagesEventsProduction(records, { ...options, roundTrip: writer<'anthropicMessages'>() });
export const writeOpenAIChatCompletionsEvents = (records: Parameters<typeof writeOpenAIChatCompletionsEventsProduction>[0], options: Omit<Parameters<typeof writeOpenAIChatCompletionsEventsProduction>[1], 'roundTrip'> = {}) =>
  writeOpenAIChatCompletionsEventsProduction(records, { ...options, roundTrip: writer<'openaiChatCompletions'>() });
export const writeOpenAIResponsesEvents = (records: Parameters<typeof writeOpenAIResponsesEventsProduction>[0], options: Omit<Parameters<typeof writeOpenAIResponsesEventsProduction>[1], 'roundTrip' | 'namespaceToolNames'> = {}) =>
  writeOpenAIResponsesEventsProduction(records, { ...options, roundTrip: writer<'openaiResponses'>(), namespaceToolNames });
export const writeGeminiGenerateContentEvents = (records: Parameters<typeof writeGeminiGenerateContentEventsProduction>[0], options: Omit<Parameters<typeof writeGeminiGenerateContentEventsProduction>[1], 'roundTrip'> = {}) =>
  writeGeminiGenerateContentEventsProduction(records, { ...options, roundTrip: writer<'geminiGenerateContent'>() });
