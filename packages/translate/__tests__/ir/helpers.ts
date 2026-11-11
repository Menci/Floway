import { consumeIRRecords, createIRBuilder, type IRRecord } from '../../src/ir/output/stream.ts';
import type { IROutput, IROutputItem } from '../../src/ir/output/types.ts';
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
import type { ProtocolFrame } from '@floway-dev/protocols/common';

export const iterate = async function* <T>(values: readonly T[]): AsyncGenerator<T> { yield* values; };
export const collect = async <T>(values: AsyncIterable<T>): Promise<T[]> => { const result: T[] = []; for await (const value of values) result.push(value); return result; };
export const events = async function* <T>(frames: AsyncIterable<ProtocolFrame<T>>): AsyncGenerator<T> { for await (const frame of frames) if (frame.type === 'event') yield frame.event; };

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
export const completeIR = (value: readonly IROutputItem[]): IRRecord[] => {
  const b = createIRBuilder();
  b.choice(0);
  b.assign(['model'], 'model');
  b.event({ type: 'start', id: 'source' });
  for (const item of value) {
    const index = b.state.choices[0].items.length;
    const path = ['choices', 0, 'items', index] as const;
    if (item.type === 'message') {
      b.initialize(path, { type: 'message', content: [] });
      item.content.forEach((part, partIndex) => {
        const partPath = [...path, 'content', partIndex] as const;
        if (part.type === 'text') {
          b.initialize(partPath, { type: 'text', text: '', ...(part.annotations === undefined ? {} : { annotations: part.annotations }) });
          b.append([...partPath, 'text'], part.text);
        } else if (part.type === 'refusal') {
          b.initialize(partPath, { type: 'refusal', refusal: '' });
          b.append([...partPath, 'refusal'], part.refusal);
        } else if (part.type === 'image') b.initialize(partPath, part);
        else {
          b.initialize(partPath, { type: 'audio', audio: { ...(part.audio.media_type === undefined ? {} : { media_type: part.audio.media_type }) } });
          for (const field of ['data', 'transcript'] as const) if (part.audio[field] !== undefined) {
            const value = part.audio[field];
            if (value === undefined) continue;
            b.initialize([...partPath, 'audio', field], '');
            b.append([...partPath, 'audio', field], value);
          }
        }
        b.event({ type: 'part_end', choice: 0, item: index, part: partIndex });
      });
    } else if (item.type === 'reasoning') {
      b.initialize(path, { type: 'reasoning', ...(item.summary === undefined ? {} : { summary: item.summary.map(() => '') }), ...(item.content === undefined ? {} : { content: item.content.map(() => '') }) });
      item.summary?.forEach((text, part) => b.append([...path, 'summary', part], text));
      item.content?.forEach((text, part) => b.append([...path, 'content', part], text));
    } else if (item.type === 'function_call') {
      b.initialize(path, { type: 'function_call', ...(item.call_id === undefined ? {} : { call_id: item.call_id }), name: item.name, arguments: '' });
      b.append([...path, 'arguments'], item.arguments);
    } else {
      b.initialize(path, { type: 'custom_tool_call', ...(item.call_id === undefined ? {} : { call_id: item.call_id }), name: item.name, input: '' });
      b.append([...path, 'input'], item.input);
    }
    b.event({ type: 'item_end', choice: 0, item: index });
  }
  b.event({ type: 'choice_end', choice: 0, finish_reason: 'stop' });
  b.event({ type: 'finish', status: 'completed' });
  return [...b.drain()];
};

export const collectIR = async (records: AsyncIterable<IRRecord>): Promise<IROutput> => {
  let state: IROutput = { choices: [] };
  for await (const value of consumeIRRecords(records)) {
    state = value.collector.state;
    if (value.record.type === 'error') throw new Error('output IR generation failed', { cause: value.record.error });
  }
  return state;
};
