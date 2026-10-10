import { Tag } from 'cbor-x';
import { describe, expect, expectTypeOf, it } from 'vitest';

import { createIAT, finalizeThinAssistantTurn, hashIRContent, registerIAT, updateIAT } from '../../../src/shared/ir/iat.ts';
import type { IRJSONObject } from '../../../src/shared/ir/ir.ts';
import type { IRProjectionResult } from '../../../src/shared/ir/round-trip-projection.ts';
import { parseIRJSONObject } from '../../../src/shared/ir/shared/json.ts';
import { createIRProjection } from '../../../src/shared/ir/shared/projection.ts';
import type { IRPath } from '../../../src/shared/ir/stream.ts';
import { IR_THIN_TAGS, type IATReference, type AnthropicMessagesThinAssistantTurn, type GeminiGenerateContentThinAssistantTurn, type IRJSONReference, type IRThinValue, type IRTextReference, type IRTextRule, type IRJSONRule, type OpenAIChatCompletionsThinAssistantTurn, type OpenAIResponsesThinAssistantTurn, type ReplaceIATReferences, type ThinReference } from '../../../src/shared/ir/thin-types.ts';
import { hydrate } from '../../../src/shared/ir/thin.ts';

const projection = (
  sourcePath: IRPath,
  sourceText: string,
  targetPath: IRPath,
  targetText: string,
  sourceStart = 0,
  sourceEndExclusive = sourceText.length,
  targetStart = 0,
  targetEndExclusive = targetText.length,
  roundTrip = true,
): IRProjectionResult => ({
  contents: [{ path: targetPath, text: targetText, round_trip: roundTrip }],
  projections: [{
    source_path: sourcePath,
    source_start: sourceStart,
    source_end_exclusive: sourceEndExclusive,
    target_path: targetPath,
    target_start: targetStart,
    target_end_exclusive: targetEndExclusive,
    round_trip: roundTrip,
  }],
});

describe('IAT and thin assistant turns', () => {
  it('recursively replaces selected text and JSON fields while preserving protocol shapes', () => {
    type Source = {
      text: string;
      items: { text: string; type: 'summary_text' }[];
      input: { ordered: number };
      encrypted_content: string;
    };
    type Thin = IRThinValue<Source, {
      text: IRTextRule;
      items: [{ text: IRTextRule }];
      input: IRJSONRule;
    }, IATReference>;
    expectTypeOf<Thin>().toEqualTypeOf<{
      text: string | IATReference<string>;
      items: { text: string | IATReference<string>; type: 'summary_text' }[];
      input: { ordered: number } | IATReference<IRJSONObject>;
      encrypted_content: string;
    }>();
    expectTypeOf<ReplaceIATReferences<IATReference<string>>>().toEqualTypeOf<string | IRTextReference>();
    expectTypeOf<ReplaceIATReferences<IATReference<IRJSONObject>>>().toEqualTypeOf<IRJSONObject | IRJSONReference>();

    type Chat = OpenAIChatCompletionsThinAssistantTurn<IATReference>;
    type Messages = AnthropicMessagesThinAssistantTurn<IATReference>;
    type Responses = OpenAIResponsesThinAssistantTurn<IATReference>;
    type Gemini = GeminiGenerateContentThinAssistantTurn<IATReference>;
    expectTypeOf<Chat['role']>().toEqualTypeOf<'assistant'>();
    expectTypeOf<Messages['role']>().toEqualTypeOf<'assistant'>();
    expectTypeOf<Messages['content']>().toExtend<unknown[]>();
    expectTypeOf<Responses>().toExtend<unknown[]>();
    expectTypeOf<Gemini>().toExtend<unknown[]>();
    expectTypeOf<Gemini[number]['role']>().toEqualTypeOf<'model'>();
    type ChatContentReference = Extract<Chat['content'], IATReference>;
    expectTypeOf<ChatContentReference>().toEqualTypeOf<IATReference<string>>();
    type MessagesToolInput = Extract<Messages['content'][number], { type: 'tool_use' }>['input'];
    expectTypeOf<Extract<MessagesToolInput, IATReference>>().toEqualTypeOf<IATReference<IRJSONObject>>();
    type GeminiAudioTranscriptionText = NonNullable<NonNullable<Gemini[number]['parts']>[number]['audioTranscription']>['text'];
    expectTypeOf<GeminiAudioTranscriptionText>().toEqualTypeOf<string | IATReference<string>>();
  });

  it('keeps a stable source ID while retaining its independent view and original B value', () => {
    const iat = createIAT();
    const path = ['choices', 0, 'items', 1, 'arguments'] as const;
    const original = parseIRJSONObject('{"x":1}');
    const view = '{ "x": 1 }';
    const first = registerIAT(iat, path, view, original, 'json');
    const second = registerIAT(iat, path, view, original, 'json');

    expect(first.id).toBe(second.id);
    expect(iat.entries.get(first.id)).toMatchObject({ view, restoration: 'json', original });
    expect(iat.entries.get(first.id)?.original).not.toBe(original);
  });

  it('references a B JSON object through an equivalent canonical A view', async () => {
    const iat = createIAT();
    const path = ['choices', 0, 'items', 0, 'arguments'] as const;
    const view = '{ "x": 1, "x": 2 }';
    const targetText = '{"x":2}';
    const original = parseIRJSONObject(view);
    const input = registerIAT(iat, path, view, original, 'json');
    updateIAT(iat, projection(path, view, ['arguments'], targetText));

    const turn: AnthropicMessagesThinAssistantTurn<IATReference> = {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'call', name: 'tool', input }],
    };
    const finalized = await finalizeThinAssistantTurn(turn, iat);
    const thinInput = (finalized.thinAssistantTurn as AnthropicMessagesThinAssistantTurn<ThinReference>).content[0];
    expect(thinInput.type).toBe('tool_use');
    if (thinInput.type !== 'tool_use') throw new Error('Expected a tool-use block');
    expect(thinInput.input).toBeInstanceOf(Tag);
    expect((thinInput.input as Tag).tag).toBe(IR_THIN_TAGS.json);

    const restored = await hydrate([targetText], finalized.thinAssistantTurn as AnthropicMessagesThinAssistantTurn<ThinReference>, finalized.referencedContents);
    expect(restored).toEqual({ ok: true, turn: { role: 'assistant', content: [{ type: 'tool_use', id: 'call', name: 'tool', input: original }] } });
  });

  it('references a B JSON object when A assigns its canonical serialization', async () => {
    const iat = createIAT();
    const path = ['choices', 0, 'items', 0, 'arguments'] as const;
    const view = '{ "x": 1 }';
    const original = parseIRJSONObject(view);
    const targetText = JSON.stringify(original);
    const projection = createIRProjection();
    projection.assign(path, targetText, ['arguments']);
    const assigned = projection.result();
    updateIAT(iat, {
      contents: assigned.contents.map(content => ({ ...content, round_trip: true })),
      projections: assigned.projections.map(span => ({ ...span, round_trip: true })),
    });
    const input = registerIAT(iat, path, view, original, 'json');
    const finalized = await finalizeThinAssistantTurn({
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'call', name: 'tool', input }],
    } satisfies AnthropicMessagesThinAssistantTurn<IATReference>, iat);

    const thinInput = (finalized.thinAssistantTurn as AnthropicMessagesThinAssistantTurn<ThinReference>).content[0];
    expect(thinInput.type).toBe('tool_use');
    if (thinInput.type !== 'tool_use') throw new Error('Expected a tool-use block');
    expect(thinInput.input).toBeInstanceOf(Tag);

    const restored = await hydrate([original], finalized.thinAssistantTurn as AnthropicMessagesThinAssistantTurn<ThinReference>, finalized.referencedContents);
    expect(restored).toEqual({ ok: true, turn: { role: 'assistant', content: [{ type: 'tool_use', id: 'call', name: 'tool', input: original }] } });
  });

  it('binds a B string only when the projected A text reconstructs the entire original string', async () => {
    const iat = createIAT();
    const path = ['source', 'text'] as const;
    const original = 'R1R2';
    const reference = registerIAT(iat, path, 'R1', original, 'text');
    updateIAT(iat, projection(path, 'R1', ['target'], original, 0, 2, 0, original.length));
    const finalized = await finalizeThinAssistantTurn({ role: 'assistant', reasoning_text: reference }, iat);

    expect(finalized.thinAssistantTurn.reasoning_text).toBeInstanceOf(Tag);
    expect(await hydrate([original], finalized.thinAssistantTurn as OpenAIChatCompletionsThinAssistantTurn<ThinReference>, finalized.referencedContents)).toMatchObject({
      ok: true,
      turn: { role: 'assistant', reasoning_text: original },
    });
  });

  it('selects one exact full-field cover when A replays the same source in multiple fields', async () => {
    const iat = createIAT();
    const path = ['source', 'reasoning'] as const;
    const text = 'reasoning';
    const reference = registerIAT(iat, path, text, text, 'text');
    updateIAT(iat, {
      contents: [
        { path: ['target', 'reasoning'], text, round_trip: true },
        { path: ['target', 'reasoning_details', 0, 'summary'], text, round_trip: true },
      ],
      projections: [
        { source_path: path, source_start: 0, source_end_exclusive: text.length, target_path: ['target', 'reasoning'], target_start: 0, target_end_exclusive: text.length, round_trip: true },
        { source_path: path, source_start: 0, source_end_exclusive: text.length, target_path: ['target', 'reasoning_details', 0, 'summary'], target_start: 0, target_end_exclusive: text.length, round_trip: true },
      ],
    });
    const finalized = await finalizeThinAssistantTurn({ role: 'assistant', reasoning_text: reference }, iat);

    expect(finalized.referencedContents).toHaveLength(1);
    expect(finalized.thinAssistantTurn.reasoning_text).toBeInstanceOf(Tag);
  });

  it('stringifies A object candidates before restoring a referenced B JSON object', async () => {
    const iat = createIAT();
    const path = ['choices', 0, 'items', 0, 'arguments'] as const;
    const view = '{"x":1}';
    const original = parseIRJSONObject(view);
    const input = registerIAT(iat, path, view, original, 'json');
    updateIAT(iat, projection(path, view, ['arguments'], view));
    const finalized = await finalizeThinAssistantTurn({ role: 'assistant', content: [{ type: 'tool_use', id: 'call', name: 'tool', input }] } satisfies AnthropicMessagesThinAssistantTurn<IATReference>, iat);

    const restored = await hydrate([{ x: 1 }], finalized.thinAssistantTurn as AnthropicMessagesThinAssistantTurn<ThinReference>, finalized.referencedContents);
    expect(restored.ok).toBe(true);
    if (!restored.ok) throw new Error('Expected the object candidate to resolve');
    expect(restored.turn.content[0]).toMatchObject({ type: 'tool_use', input: { x: 1 } });
  });

  it('restores raw numeric JSON tokens from a whitespace-preserving source view', async () => {
    const iat = createIAT();
    const path = ['source', 'arguments'] as const;
    const view = '{ "n" : 9007199254740993 }';
    const targetText = '{"n":9007199254740993}';
    const original = parseIRJSONObject('{"n":9007199254740993}');
    const input = registerIAT(iat, path, view, original, 'json');
    updateIAT(iat, projection(path, view, ['target'], targetText));
    const finalized = await finalizeThinAssistantTurn({ role: 'assistant', content: [{ type: 'tool_use', id: 'call', name: 'tool', input }] } satisfies AnthropicMessagesThinAssistantTurn<IATReference>, iat);
    const restored = await hydrate([parseIRJSONObject(targetText)], finalized.thinAssistantTurn as AnthropicMessagesThinAssistantTurn<ThinReference>, finalized.referencedContents);

    expect(restored.ok).toBe(true);
    if (!restored.ok) throw new Error('Expected the exact JSON source view to resolve');
    expect(JSON.stringify(restored.turn.content[0])).toContain('"n":9007199254740993');
  });

  it('keeps the whole B value when text or JSON restoration cannot recover it', async () => {
    const textCases: { view: string; target: string; start: number; end: number; original: string }[] = [
      { view: 'hello', target: 'hello', start: 0, end: 2, original: 'hello' },
      { view: 'R1', target: 'R1', start: 0, end: 2, original: 'R1R2' },
    ];
    for (const [index, testCase] of textCases.entries()) {
      const iat = createIAT();
      const path = ['source', index] as const;
      const reference = registerIAT(iat, path, testCase.view, testCase.original, 'text');
      updateIAT(iat, projection(path, testCase.view, ['target'], testCase.target, testCase.start, testCase.end));
      const finalized = await finalizeThinAssistantTurn({ role: 'assistant', content: reference } satisfies OpenAIChatCompletionsThinAssistantTurn<IATReference>, iat);
      expect((finalized.thinAssistantTurn as OpenAIChatCompletionsThinAssistantTurn<ThinReference>).content).toEqual(testCase.original);
      expect(finalized.referencedContents).toEqual([]);
    }

    const jsonCases: { view: string; target: string; start: number; end: number; original: IRJSONObject }[] = [
      { view: '{"x":1', target: '{"x":1', start: 0, end: '{"x":1'.length, original: { x: 1 } },
      { view: 'code', target: 'code', start: 0, end: 'code'.length, original: { input: 'code' } },
      { view: '{"x":1}', target: '{"x":1}', start: 0, end: '{"x":1}'.length, original: { x: 2 } },
      { view: '{"a":1,"b":2}', target: '{"a":1,"b":2}', start: 0, end: '{"a":1,"b":2}'.length, original: { b: 2, a: 1 } },
    ];
    for (const [index, testCase] of jsonCases.entries()) {
      const iat = createIAT();
      const path = ['source', index] as const;
      const reference = registerIAT(iat, path, testCase.view, testCase.original, 'json');
      updateIAT(iat, projection(path, testCase.view, ['target'], testCase.target, testCase.start, testCase.end));
      const finalized = await finalizeThinAssistantTurn({
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call', name: 'tool', input: reference }],
      } satisfies AnthropicMessagesThinAssistantTurn<IATReference>, iat);
      expect((finalized.thinAssistantTurn as AnthropicMessagesThinAssistantTurn<ThinReference>).content[0]).toMatchObject({ input: testCase.original });
      expect(finalized.referencedContents).toEqual([]);
    }
  });

  it('concatenates target ranges with UTF-16 offsets and preserves isolated surrogates', async () => {
    const iat = createIAT();
    const path = ['source', 'reasoning'] as const;
    const text = '\ud800a\udc00?';
    const first = text.slice(0, 2);
    const second = text.slice(2);
    const firstTarget = `x${first}y`;
    const secondTarget = `[${second}]`;
    const reference = registerIAT(iat, path, text, text, 'text');
    updateIAT(iat, {
      contents: [
        { path: ['target', 0], text: firstTarget, round_trip: true },
        { path: ['target', 1], text: secondTarget, round_trip: true },
      ],
      projections: [
        { source_path: path, source_start: 0, source_end_exclusive: first.length, target_path: ['target', 0], target_start: 1, target_end_exclusive: 1 + first.length, round_trip: true },
        { source_path: path, source_start: first.length, source_end_exclusive: text.length, target_path: ['target', 1], target_start: 1, target_end_exclusive: 1 + second.length, round_trip: true },
      ],
    });
    const finalized = await finalizeThinAssistantTurn({ role: 'assistant', content: reference } satisfies OpenAIChatCompletionsThinAssistantTurn<IATReference>, iat);
    const thinContent = (finalized.thinAssistantTurn as OpenAIChatCompletionsThinAssistantTurn<ThinReference>).content;
    expect(thinContent).toBeInstanceOf(Tag);
    expect((thinContent as Tag).value).toEqual([[0, 1, 3], [1, 1, 3]]);
    expect(finalized.referencedContents).toHaveLength(2);

    const restored = await hydrate([firstTarget, secondTarget], finalized.thinAssistantTurn as OpenAIChatCompletionsThinAssistantTurn<ThinReference>, finalized.referencedContents);
    expect(restored).toEqual({ ok: true, turn: { role: 'assistant', content: text } });
    expect(await hashIRContent(text)).not.toEqual(await hashIRContent(text.toWellFormed()));
  });

  it('deduplicates shared content hashes and keeps encrypted B fields literal', async () => {
    const iat = createIAT();
    const summaryPath = ['source', 'summary'] as const;
    const reasoningPath = ['source', 'reasoning'] as const;
    const summary = registerIAT(iat, summaryPath, 'same', 'same', 'text');
    const reasoning = registerIAT(iat, reasoningPath, 'same', 'same', 'text');
    updateIAT(iat, {
      contents: [
        { path: ['target', 'summary'], text: 'same', round_trip: true },
        { path: ['target', 'reasoning'], text: 'same', round_trip: true },
      ],
      projections: [
        { source_path: summaryPath, source_start: 0, source_end_exclusive: 4, target_path: ['target', 'summary'], target_start: 0, target_end_exclusive: 4, round_trip: true },
        { source_path: reasoningPath, source_start: 0, source_end_exclusive: 4, target_path: ['target', 'reasoning'], target_start: 0, target_end_exclusive: 4, round_trip: true },
      ],
    });
    const turn: OpenAIResponsesThinAssistantTurn<IATReference> = [
      { type: 'reasoning', id: 'r', summary: [{ type: 'summary_text', text: summary }], encrypted_content: 'same' },
      { type: 'reasoning', id: 'r2', summary: [{ type: 'summary_text', text: reasoning }], encrypted_content: 'native-signature-value' },
    ];
    const finalized = await finalizeThinAssistantTurn(turn, iat);

    expect(finalized.referencedContents).toHaveLength(1);
    const items = finalized.thinAssistantTurn as OpenAIResponsesThinAssistantTurn<ThinReference>;
    expect((items[0] as { type: 'reasoning'; summary: { text: Tag }[] }).summary[0].text.value).toEqual([0]);
    expect((items[1] as { type: 'reasoning'; summary: { text: Tag }[] }).summary[0].text.value).toEqual([0]);
    expect((items[0] as { type: 'reasoning'; encrypted_content: string }).encrypted_content).toBe('same');
    expect((items[1] as { type: 'reasoning'; encrypted_content: string }).encrypted_content).toBe('native-signature-value');
  });

  it('references optional Gemini audio-transcription metadata on a model Part', async () => {
    const iat = createIAT();
    const path = ['source', 'audio_transcription'] as const;
    const text = 'recognized speech';
    const reference = registerIAT(iat, path, text, text, 'text');
    updateIAT(iat, projection(path, text, ['target', 'audioTranscription', 'text'], text));
    const turn: GeminiGenerateContentThinAssistantTurn<IATReference> = [{
      role: 'model',
      parts: [{ text: 'spoken response', audioTranscription: { text: reference } }],
    }];
    const finalized = await finalizeThinAssistantTurn(turn, iat);
    const part = finalized.thinAssistantTurn[0].parts?.[0];

    expect(part?.audioTranscription?.text).toBeInstanceOf(Tag);
    const restored = await hydrate([text], finalized.thinAssistantTurn, finalized.referencedContents);
    expect(restored).toMatchObject({ ok: true, turn: [{ role: 'model', parts: [{ text: 'spoken response', audioTranscription: { text } }] }] });
  });

  it('fails the whole hydration when any referenced candidate is missing', async () => {
    const iat = createIAT();
    const firstPath = ['source', 0] as const;
    const secondPath = ['source', 1] as const;
    const first = registerIAT(iat, firstPath, 'first', 'first', 'text');
    const second = registerIAT(iat, secondPath, 'second', 'second', 'text');
    updateIAT(iat, {
      contents: [
        { path: ['target', 0], text: 'first', round_trip: true },
        { path: ['target', 1], text: 'second', round_trip: true },
      ],
      projections: [
        { source_path: firstPath, source_start: 0, source_end_exclusive: 5, target_path: ['target', 0], target_start: 0, target_end_exclusive: 5, round_trip: true },
        { source_path: secondPath, source_start: 0, source_end_exclusive: 6, target_path: ['target', 1], target_start: 0, target_end_exclusive: 6, round_trip: true },
      ],
    });
    const finalized = await finalizeThinAssistantTurn([
      { type: 'reasoning', id: 'r1', summary: [{ type: 'summary_text', text: first }] },
      { type: 'reasoning', id: 'r2', summary: [{ type: 'summary_text', text: second }] },
    ] satisfies OpenAIResponsesThinAssistantTurn<IATReference>, iat);
    const responses = finalized.thinAssistantTurn as OpenAIResponsesThinAssistantTurn<ThinReference>;

    expect(await hydrate(['first'], responses, finalized.referencedContents)).toEqual({ ok: false, reason: 'missing-reference' });
    expect(responses.every(item => item.type === 'reasoning' && item.summary?.[0]?.text instanceof Tag)).toBe(true);
  });

  it('lets invalid JSON reference errors propagate', async () => {
    const malformed = {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'call', name: 'tool', input: new Tag([0], IR_THIN_TAGS.json) }],
    } as AnthropicMessagesThinAssistantTurn<ThinReference>;
    const hash = await hashIRContent('{');

    await expect(hydrate(['{'], malformed, [hash])).rejects.toThrow();
  });

});
