import type { IRRecord } from '../../src/ir/output/records.ts';
import { anthropicMessagesFromIR as anthropicMessagesFromIRProduction } from '../../src/protocols/anthropic-messages/as-source/sse-to.ts';
import { irFromAnthropicMessages as irFromAnthropicMessagesProduction } from '../../src/protocols/anthropic-messages/as-target/sse-from.ts';
import { geminiGenerateContentFromIR as geminiGenerateContentFromIRProduction } from '../../src/protocols/gemini-generate-content/as-source/sse-to.ts';
import { openaiChatCompletionsFromIR as openaiChatCompletionsFromIRProduction } from '../../src/protocols/openai-chat-completions/as-source/sse-to.ts';
import { irFromOpenAIChatCompletions as irFromOpenAIChatCompletionsProduction } from '../../src/protocols/openai-chat-completions/as-target/sse-from.ts';
import { flattenNamespaceTools } from '../../src/protocols/openai-responses/as-source/namespace-tools.ts';
import { openaiResponsesFromIR as openaiResponsesFromIRProduction } from '../../src/protocols/openai-responses/as-source/sse-to.ts';
import { irFromOpenAIResponses as irFromOpenAIResponsesProduction } from '../../src/protocols/openai-responses/as-target/sse-from.ts';
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

export const irFromAnthropicMessages = (frames: Parameters<typeof irFromAnthropicMessagesProduction>[0], options: Omit<Parameters<typeof irFromAnthropicMessagesProduction>[1], 'roundTrip'> = {}) =>
  withoutProvenance(irFromAnthropicMessagesProduction(frames, { ...options, roundTrip: reader<'anthropicMessages'>() }));
export const irFromOpenAIChatCompletions = (frames: Parameters<typeof irFromOpenAIChatCompletionsProduction>[0], options: Omit<Parameters<typeof irFromOpenAIChatCompletionsProduction>[1], 'roundTrip'> = {}) =>
  withoutProvenance(irFromOpenAIChatCompletionsProduction(frames, { ...options, roundTrip: reader<'openaiChatCompletions'>() }));
export const irFromOpenAIResponses = (
  frames: Parameters<typeof irFromOpenAIResponsesProduction>[0],
  roundTrip: RoundTripReader<'openaiResponses'> = reader<'openaiResponses'>(),
) => withoutProvenance(irFromOpenAIResponsesProduction(frames, { roundTrip }));
export const anthropicMessagesFromIR = (records: Parameters<typeof anthropicMessagesFromIRProduction>[0], options: Omit<Parameters<typeof anthropicMessagesFromIRProduction>[1], 'roundTrip'> = {}) =>
  anthropicMessagesFromIRProduction(records, { ...options, roundTrip: writer<'anthropicMessages'>() });
export const openaiChatCompletionsFromIR = (records: Parameters<typeof openaiChatCompletionsFromIRProduction>[0], options: Omit<Parameters<typeof openaiChatCompletionsFromIRProduction>[1], 'roundTrip'> = {}) =>
  openaiChatCompletionsFromIRProduction(records, { ...options, roundTrip: writer<'openaiChatCompletions'>() });
export const openaiResponsesFromIR = (records: Parameters<typeof openaiResponsesFromIRProduction>[0], options: Omit<Parameters<typeof openaiResponsesFromIRProduction>[1], 'roundTrip' | 'namespaceToolNames'> = {}) =>
  openaiResponsesFromIRProduction(records, { ...options, roundTrip: writer<'openaiResponses'>(), namespaceToolNames });
export const geminiGenerateContentFromIR = (records: Parameters<typeof geminiGenerateContentFromIRProduction>[0], options: Omit<Parameters<typeof geminiGenerateContentFromIRProduction>[1], 'roundTrip'> = {}) =>
  geminiGenerateContentFromIRProduction(records, { ...options, roundTrip: writer<'geminiGenerateContent'>() });
