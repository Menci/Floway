import { Encoder, Tag } from 'cbor-x';
import { describe, expect, expectTypeOf, it } from 'vitest';

import { createIRIAT, fillIRIAT, hashIRContent } from '../iat.ts';
import type { IR } from '../ir.ts';
import { cloneIRJSON, irJSON, parseIRJSONObject } from '../json.ts';
import type { IRProjectionResult } from '../projection.ts';
import type { IRTextReference, IRThinResponsesItem, IRThinValue } from '../thin-types.ts';
import { buildIRReplayItems, createIRPendingThinItems, createIRThinCodec, finalizeIRThinItems } from '../thin.ts';

const tags = { text: 70000, json: 70001, utf16: 70002 };
const codec = createIRThinCodec(tags);
const source = (text: string): IR => ({ choices: [{ items: [{ type: 'reasoning', summary: [text] }] }] });
const path = ['choices', 0, 'items', 0, 'summary', 0];
const projectionFor = (text: string, roundTrip = true): IRProjectionResult => ({ contents: [{ path: ['content'], text, round_trip: roundTrip }], projections: [{ source_path: path, source_start: 0, source_end_exclusive: text.length, target_path: ['content'], target_start: 0, target_end_exclusive: text.length, round_trip: roundTrip }] });

describe('thin items and IAT', () => {
  it('derives nested arrays, objects, optional and nullable leaves', () => {
    type Source = { summary?: { text: string; kind: 'summary_text' }[] | null };
    type Thin = IRThinValue<Source, { summary: [{ text: { $text: true } }] }>;
    expectTypeOf<Thin>().toEqualTypeOf<{ summary?: { text: string | IRTextReference; kind: 'summary_text' }[] | null }>();
  });

  it('stores hashes once and restores selected reasoning leaves', async () => {
    const iat = createIRIAT(source('hello'));
    const pending = createIRPendingThinItems('openaiResponses', [{ type: 'reasoning', id: 'r', summary: [{ type: 'summary_text', text: 'hello' }], encrypted_content: 'hidden' }], iat);
    fillIRIAT(iat, projectionFor('hello'));
    const thin = await finalizeIRThinItems(pending, iat, tags);
    expect(thin.referencedContents).toHaveLength(1);
    const item = thin.items[0] as any;
    expect(item.summary[0].text).toBeInstanceOf(Tag);
    expect(item.summary[0].text.value).toEqual([0]);
    expect(item.encrypted_content).toBe('hidden');
    expect(await codec.restore(codec.decode(codec.encode(thin)), ['hello'])).toEqual([{ type: 'reasoning', id: 'r', summary: [{ type: 'summary_text', text: 'hello' }], encrypted_content: 'hidden' }]);
  });

  it('remaps fragmented source strings into final concatenated target ranges', async () => {
    const iat = createIRIAT(source('ac'));
    const pending = createIRPendingThinItems('openaiResponses', [{ type: 'reasoning', id: 'r', summary: [{ type: 'summary_text', text: 'ac' }] }], iat);
    fillIRIAT(iat, {
      contents: [{ path: ['content'], text: 'abc', round_trip: true }], projections: [
        { source_path: path, source_start: 0, source_end_exclusive: 1, target_path: ['content'], target_start: 0, target_end_exclusive: 1, round_trip: true },
        { source_path: path, source_start: 1, source_end_exclusive: 2, target_path: ['content'], target_start: 2, target_end_exclusive: 3, round_trip: true },
      ],
    });
    const thin = await finalizeIRThinItems(pending, iat, tags);
    expect((thin.items[0] as any).summary[0].text.value).toEqual([[0, 0, 1], [0, 2, 3]]);
    expect(await codec.restore(thin, ['abc'])).toMatchObject([{ summary: [{ text: 'ac' }] }]);
  });

  it('keeps the whole original string when projection is partial or not round-tripped', async () => {
    for (const partial of [false, true]) {
      const iat = createIRIAT(source('hello'));
      const pending = createIRPendingThinItems('openaiResponses', [{ type: 'reasoning', id: 'r', summary: [{ type: 'summary_text', text: 'hello' }] }], iat);
      const projection = projectionFor('hello', partial);
      if (partial) projection.projections[0].source_end_exclusive = 2;
      fillIRIAT(iat, projection);
      const thin = await finalizeIRThinItems(pending, iat, tags);
      expect((thin.items[0] as any).summary[0].text).toBe('hello');
    }
  });

  it('restores object arguments through a JSON tag and preserves key order', async () => {
    const input = { b: 2, a: 1 };
    const ir: IR = { choices: [{ items: [{ type: 'function_call', name: 'tool', arguments: input }] }] };
    const iat = createIRIAT(ir);
    const pending = createIRPendingThinItems('anthropicMessages', [{ type: 'tool_use', id: 'call', name: 'tool', input }], iat);
    const text = JSON.stringify(input);
    fillIRIAT(iat, { contents: [{ path: ['arguments'], text, round_trip: true }], projections: [{ source_path: ['choices', 0, 'items', 0, 'arguments'], source_start: 0, source_end_exclusive: text.length, target_path: ['arguments'], target_start: 0, target_end_exclusive: text.length, round_trip: true }] });
    const thin = await finalizeIRThinItems(pending, iat, tags);
    expect((thin.items[0] as any).input.tag).toBe(tags.json);
    const restored = await codec.restore(thin, [text]);
    expect(JSON.stringify((restored[0] as any).input)).toBe(text);
  });

  it('retains noncanonical JSON strings when the target object loses their spelling', async () => {
    const original = '{ "b": 2, "a": 1 }';
    const ir: IR = { choices: [{ items: [{ type: 'function_call', name: 'tool', arguments: original }] }] };
    const iat = createIRIAT(ir);
    const pending = createIRPendingThinItems('openaiResponses', [{ type: 'function_call', name: 'tool', call_id: 'call', arguments: original }], iat);
    const text = JSON.stringify(JSON.parse(original));
    fillIRIAT(iat, { contents: [{ path: ['input'], text, round_trip: true }], projections: [{ source_path: ['choices', 0, 'items', 0, 'arguments'], source_start: 0, source_end_exclusive: text.length, target_path: ['input'], target_start: 0, target_end_exclusive: text.length, round_trip: true }] });
    const thin = await finalizeIRThinItems(pending, iat, tags);
    expect((thin.items[0] as any).arguments).toBe(original);
  });

  it('rejects altered or missing referenced text', async () => {
    const iat = createIRIAT(source('hello')); fillIRIAT(iat, projectionFor('hello'));
    const thin = await finalizeIRThinItems(createIRPendingThinItems('openaiResponses', [{ type: 'reasoning', id: 'r', summary: [{ type: 'summary_text', text: 'hello' }] }], iat), iat, tags);
    await expect(codec.restore(thin, ['changed'])).rejects.toThrow('checksum');
  });

  it('preserves short and long isolated surrogates, metadata keys and hashes', async () => {
    for (const text of ['\ud800', `\ud800${'x'.repeat(100)}`]) {
      expect(await hashIRContent(text)).not.toEqual(await hashIRContent(text.toWellFormed()));
      const original = JSON.parse('{"__proto__":{"x":1}}');
      original.reasoning_text = text;
      const envelope: any = { protocol: 'openaiChatCompletions', referencedContents: [], items: [{ role: 'assistant', content: text, ...original }] };
      const decoded = codec.decode(codec.encode(envelope));
      expect(decoded.items).toEqual(envelope.items);
      expect(Object.hasOwn(decoded.items[0], '__proto__')).toBe(true);
    }
  });

  it('reduces output-only replay fields without touching input objects', () => {
    const result = { choices: [{ message: { role: 'assistant', content: 'text', annotations: [], audio: { id: 'audio', data: 'bytes', transcript: 'words', expires_at: 1 } } }] };
    expect(buildIRReplayItems('openaiChatCompletions', result)).toEqual([{ role: 'assistant', content: 'text', audio: { id: 'audio' } }]);
    expect(result.choices[0].message.audio.data).toBe('bytes');
    expect(buildIRReplayItems('openaiResponses', { output: [{ type: 'web_search_call', id: 'w', results: [{ text: 'output-only' }] }] })).toEqual([{ type: 'web_search_call', id: 'w' }]);
  });

  it('keeps server and MCP tool fields literal even when their strings match IR', async () => {
    const iat = createIRIAT(source('hello')); fillIRIAT(iat, projectionFor('hello'));
    const replay: any = [{ type: 'mcp_call', id: 'm', name: 'tool', arguments: 'hello' }];
    const thin = await finalizeIRThinItems(createIRPendingThinItems('openaiResponses', replay, iat), iat, tags);
    expect(thin.items).toEqual(replay);
  });

  it('requires distinct tags that do not collide with cbor-x built-ins', () => {
    expect(() => createIRThinCodec({ text: 258, json: 70001, utf16: 70002 })).toThrow();
    expect(() => createIRThinCodec({ text: 70000, json: 70000, utf16: 70002 })).toThrow();
  });
  it('keeps MCP argument types literal', () => {
    expectTypeOf<Extract<IRThinResponsesItem, { type: 'mcp_call' }>['arguments']>().toEqualTypeOf<string>();
  });

  it('preserves raw unsafe integers through JSON cloning and CBOR', async () => {
    const input = parseIRJSONObject('{"n":9007199254740993}');
    expect(JSON.stringify(cloneIRJSON(input))).toBe('{"n":9007199254740993}');
    const rawCodec = createIRThinCodec({ ...tags, rawJSON: 70003 });
    const envelope: any = { protocol: 'anthropicMessages', referencedContents: [], items: [{ type: 'tool_use', id: 'c', name: 't', input }] };
    const decoded = rawCodec.decode(rawCodec.encode(envelope));
    expect(irJSON.isRawJSON((decoded.items[0] as any).input.n)).toBe(true);
    expect(JSON.stringify(await rawCodec.restore(decoded, []))).toBe(JSON.stringify(envelope.items));
    expect(() => codec.encode(envelope)).toThrow('rawJSON tag');
  });

  it('validates decoded envelopes', () => {
    const encoder = new Encoder({ useRecords: false });
    for (const value of [{}, { protocol: 'unknown', referencedContents: [], items: [] }, { protocol: 'openaiResponses', referencedContents: ['hash'], items: [] }]) {
      expect(() => codec.decode(encoder.encode(value))).toThrow('envelope');
    }
  });

  it('references object arguments through a noncanonical target JSON string', async () => {
    const input = { b: 2, a: 1 };
    const text = '{ "b": 2, "a": 1 }';
    const iat = createIRIAT({ choices: [{ items: [{ type: 'function_call', name: 't', arguments: input }] }] });
    const pending = createIRPendingThinItems('anthropicMessages', [{ type: 'tool_use', id: 'c', name: 't', input }], iat);
    fillIRIAT(iat, { contents: [{ path: ['args'], text, round_trip: true }], projections: [{ source_path: ['choices', 0, 'items', 0, 'arguments'], source_start: 0, source_end_exclusive: text.length, target_path: ['args'], target_start: 0, target_end_exclusive: text.length, round_trip: true }] });
    const thin = await finalizeIRThinItems(pending, iat, tags);
    expect((thin.items[0] as any).input).toBeInstanceOf(Tag);
    expect(await codec.restore(thin, [text])).toMatchObject([{ input }]);
  });

  it('omits unused hashes and preserves empty literals', async () => {
    for (const text of ['hello', '']) {
      const iat = createIRIAT(source(text));
      fillIRIAT(iat, projectionFor(text, false));
      const thin = await finalizeIRThinItems(createIRPendingThinItems('openaiResponses', [{ type: 'reasoning', id: 'r', summary: [{ type: 'summary_text', text }] }], iat), iat, tags);
      expect(thin.referencedContents).toEqual([]);
      expect((thin.items[0] as any).summary[0].text).toBe(text);
    }
  });

  it.each(['1e400', '9007199254740993.0'])('preserves out-of-range numeric lexeme %s', token => {
    const text = `{"n":${token}}`;
    expect(JSON.stringify(cloneIRJSON(parseIRJSONObject(text)))).toBe(text);
  });

});
