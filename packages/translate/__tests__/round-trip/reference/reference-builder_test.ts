import { describe, expect, it, vi } from 'vitest';

import type { IRJSONObject } from '../../../src/ir/output/types.ts';
import { collectAnthropicMessagesTextViews } from '../../../src/protocols/anthropic-messages/as-source/round-trip.ts';
import type { AnthropicMessagesReferenceableAssistantTurn } from '../../../src/protocols/anthropic-messages/as-target/assistant-turn.ts';
import { collectGeminiGenerateContentTextViews } from '../../../src/protocols/gemini-generate-content/as-source/round-trip.ts';
import type { GeminiGenerateContentAssistantState, GeminiGenerateContentInputAssistantTurn } from '../../../src/protocols/gemini-generate-content/as-target/assistant-turn.ts';
import type { OpenAIChatCompletionsAssistantState, OpenAIChatCompletionsInputAssistantTurn } from '../../../src/protocols/openai-chat-completions/as-target/assistant-turn.ts';
import { ContentReference } from '../../../src/round-trip/reference/assistant-turn.ts';
import {
  appendContent,
  appendField,
  collectEmittedFieldPlacements,
  createReferenceBuilder,
  createEmittedFieldState,
  createFieldState,
  createFieldReferencer,
  invalidateField,
  type EmittedFieldStates,
  type ReadFieldStates,
} from '../../../src/round-trip/reference/reference-builder.ts';
import { referenceAssistantTurn } from '../../../src/round-trip/reference/reference-selection.ts';
import { restoreAssistantTurn } from '../../../src/round-trip/reference/restore.ts';
import { hashRoundTripContent } from '../../../src/round-trip/turn-digest.ts';
import { parseJSONObject } from '../../../src/shared/json/object.ts';

describe('ReferenceBuilder', () => {
  it('applies channel views only to their owning field on a multi-field part', () => {
    const builder = createReferenceBuilder();
    const visible = createEmittedFieldState(builder, 'text');
    const transcript = createEmittedFieldState(builder, 'text');
    appendContent(builder, visible, 'visible');
    appendContent(builder, transcript, 'transcript');
    const turn: GeminiGenerateContentInputAssistantTurn = [{
      role: 'model',
      parts: [{ text: 'visible', audioTranscription: { text: 'transcript' } }],
    }];
    const state: GeminiGenerateContentAssistantState<EmittedFieldStates> = [{
      parts: [{ text: visible, audioTranscription: { text: transcript } }],
    }];

    expect(collectEmittedFieldPlacements(turn, state, collectGeminiGenerateContentTextViews(turn))).toEqual(new Map([
      [visible.contentId, { enclosingText: 'visible', offset: 0 }],
      [transcript.contentId, { enclosingText: 'transcript', offset: 0 }],
    ]));
  });

  it('keeps provenance directly in sparse state leaves across shallow copies', async () => {
    const builder = createReferenceBuilder();
    const field = createFieldState('text');
    const first = appendField(builder, field, 'hel');
    const second = appendField(builder, field, 'lo');
    const content = createEmittedFieldState(builder, 'text');
    appendContent(builder, content, '[');
    appendContent(builder, content, 'hello', [first, second]);
    appendContent(builder, content, ']');

    const fieldState = { content: [{ text: { ...field } }] };
    const contentState = { content: [{ text: { ...content } }] };
    expect(fieldState.content[0].text).toMatchObject({ kind: 'text', text: 'hello', textFragmentIds: [first, second] });
    expect(contentState.content[0].text).toMatchObject({ kind: 'text', contentId: 0, text: '[hello]' });

    const turn = { role: 'assistant' as const, content: [{ type: 'text' as const, text: '[hello]', citations: null }] };
    const finalizer = createFieldReferencer(builder, collectEmittedFieldPlacements(turn, contentState));
    expect(await finalizer.referenceField('hello', fieldState.content[0].text)).toEqual(new ContentReference('text', [[0, 1, 6]]));
  });

  it('hashes one canonical text run only once across multiple content IDs and shifts their ranges', async () => {
    const builder = createReferenceBuilder();
    const left = 'left segment '.repeat(30);
    const right = 'right segment '.repeat(30);
    const fields = [createFieldState('text'), createFieldState('text')];
    const contents = [createEmittedFieldState(builder, 'text'), createEmittedFieldState(builder, 'text')];
    appendContent(builder, contents[0], left, [appendField(builder, fields[0], left)]);
    appendContent(builder, contents[1], right, [appendField(builder, fields[1], right)]);
    const turn = { role: 'assistant' as const, content: [{ type: 'text' as const, text: left, citations: null }, { type: 'text' as const, text: right, citations: null }] };
    const views = collectEmittedFieldPlacements(turn, { content: contents.map(text => ({ text })) }, collectAnthropicMessagesTextViews([turn]));
    const finalizer = createFieldReferencer(builder, views);
    const digest = vi.spyOn(crypto.subtle, 'digest');
    try {
      expect(await finalizer.referenceField(left, fields[0])).toMatchObject({ parts: [[0, 0, left.length]] });
      expect(await finalizer.referenceField(right, fields[1])).toMatchObject({ parts: [[0, left.length, left.length + right.length]] });
      expect(digest).toHaveBeenCalledTimes(1);
    } finally {
      digest.mockRestore();
    }
    expect(finalizer.referencedContentHashes).toEqual([await hashRoundTripContent(left + right)]);
  });

  it('looks up equal complete texts once per content ID rather than once per SSE atom', async () => {
    const builder = createReferenceBuilder();
    const fields = [createFieldState('text'), createFieldState('text')];
    const contents = fields.map(() => createEmittedFieldState(builder, 'text'));
    const texts = contents.map(() => Array.from({ length: 128 }, () => 'abcdefgh').join(''));
    for (const [index, field] of fields.entries()) {
      for (let offset = 0; offset < texts[index].length; offset += 8) {
        const piece = texts[index].slice(offset, offset + 8);
        appendContent(builder, contents[index], piece, [appendField(builder, field, piece)]);
      }
    }
    const views = new Map(contents.flatMap((content, index) => [...collectEmittedFieldPlacements(texts[index], content)]));
    const finalizer = createFieldReferencer(builder, views);
    const digest = vi.spyOn(crypto.subtle, 'digest');
    const lookups = vi.spyOn(Map.prototype, 'get');
    let completeTextLookups: number;
    let hashCalls: number;
    try {
      for (const [index, field] of fields.entries()) await finalizer.referenceField(texts[index], field);
      completeTextLookups = lookups.mock.calls.filter(([key]) => key === texts[0]).length;
      hashCalls = digest.mock.calls.length;
    } finally {
      lookups.mockRestore();
      digest.mockRestore();
    }
    expect(completeTextLookups).toBe(contents.length);
    expect(hashCalls).toBe(1);
    expect(finalizer.referencedContentHashes).toEqual([await hashRoundTripContent(texts[0])]);
  });

  it('coalesces shifted ranges across canonical parts and preserves original-leaf validation', async () => {
    const builder = createReferenceBuilder();
    const field = createFieldState('text');
    const contents = [createEmittedFieldState(builder, 'text'), createEmittedFieldState(builder, 'text')];
    const left = 'prefix \ud83d';
    const right = '\ude00 suffix';
    appendContent(builder, contents[0], left, [appendField(builder, field, left)]);
    appendContent(builder, contents[1], right, [appendField(builder, field, right)]);
    const turn = { role: 'assistant' as const, content: [{ type: 'text' as const, text: left, citations: null }, { type: 'text' as const, text: right, citations: null }] };
    const state = { content: contents.map(text => ({ text })) };
    const finalizer = createFieldReferencer(builder, collectEmittedFieldPlacements(turn, state, collectAnthropicMessagesTextViews([turn])));
    expect(await finalizer.referenceField(left + right, field)).toMatchObject({ parts: [0] });
    const changed = { ...turn, content: [{ ...turn.content[0], text: 'changed' }, turn.content[1]] };
    const changedFinalizer = createFieldReferencer(builder, collectEmittedFieldPlacements(changed, state, collectAnthropicMessagesTextViews([changed])));
    expect(await changedFinalizer.referenceField(left + right, field)).toBe(left + right);
    expect(changedFinalizer.referencedContentHashes).toEqual([]);
  });

  it('resolves every original SSE atom within one merged output IR append', async () => {
    const builder = createReferenceBuilder();
    const field = createFieldState('text');
    const first = appendField(builder, field, 'hel');
    const second = appendField(builder, field, 'lo');
    const content = createEmittedFieldState(builder, 'text');
    appendContent(builder, content, '[');
    appendContent(builder, content, 'hello', [first, second]);
    appendContent(builder, content, ']');
    const finalizer = createFieldReferencer(builder, collectEmittedFieldPlacements('[hello]', content));
    expect(await finalizer.referenceField('hello', field)).toMatchObject({ parts: [[0, 1, 6]] });
  });
  it('resolves B SSE atoms directly into one A content occurrence', async () => {
    const builder = createReferenceBuilder();
    const field = createFieldState('text');
    const first = appendField(builder, field, 'hel');
    const second = appendField(builder, field, 'lo');
    const content = createEmittedFieldState(builder, 'text');

    appendContent(builder, content, '[');
    appendContent(builder, content, 'hel', [first]);
    appendContent(builder, content, 'lo', [second]);
    appendContent(builder, content, ']');

    const finalizer = createFieldReferencer(builder, collectEmittedFieldPlacements('[hello]', content));
    const reference = await finalizer.referenceField('hello', field);

    if (!(reference instanceof ContentReference)) throw new Error('Expected a thin reference');
    expect(reference.kind).toBe('text');
    expect(reference.parts).toEqual([[0, 1, 6]]);
    expect(finalizer.referencedContentHashes).toEqual([new Uint8Array([150, 39, 93, 50, 178, 83, 23, 204])]);
  });

  it('simplifies a reference covering the whole hashed content', async () => {
    const builder = createReferenceBuilder();
    const field = createFieldState('text');
    const first = appendField(builder, field, 'hel');
    const second = appendField(builder, field, 'lo');
    const content = createEmittedFieldState(builder, 'text');
    appendContent(builder, content, 'hel', [first]);
    appendContent(builder, content, 'lo', [second]);

    const finalizer = createFieldReferencer(builder, collectEmittedFieldPlacements('hello', content));
    const reference = await finalizer.referenceField('hello', field);

    if (!(reference instanceof ContentReference)) throw new Error('Expected a thin reference');
    expect(reference.parts).toEqual([0]);
  });

  it('keeps the whole original field when any SSE atom is unresolved', async () => {
    const builder = createReferenceBuilder();
    const field = createFieldState('text');
    const first = appendField(builder, field, 'hel');
    appendField(builder, field, 'lo');
    const content = createEmittedFieldState(builder, 'text');
    appendContent(builder, content, 'hel', [first]);

    const finalizer = createFieldReferencer(builder, collectEmittedFieldPlacements('hel', content));
    expect(await finalizer.referenceField('hello', field)).toBe('hello');
    expect(finalizer.referencedContentHashes).toEqual([]);
  });

  it('keeps an invalidated field literal and rejects later provenance capture', async () => {
    const builder = createReferenceBuilder();
    const field = createFieldState('text');
    const partId = appendField(builder, field, 'hello');
    const content = createEmittedFieldState(builder, 'text');
    appendContent(builder, content, 'hello', [partId]);
    const copiedParent = { text: field };
    invalidateField(field);

    expect(copiedParent.text).toBe(field);
    expect(copiedParent.text.valid).toBe(false);
    const finalizer = createFieldReferencer(builder, collectEmittedFieldPlacements('hello', content));
    expect(await finalizer.referenceField('hello', field)).toBe('hello');
    expect(finalizer.referencedContentHashes).toEqual([]);
    expect(() => appendField(builder, field, '!')).toThrowError('Cannot append provenance to an invalid field');
  });

  it('discards resolutions when the final input text view changed', async () => {
    const builder = createReferenceBuilder();
    const field = createFieldState('text');
    const partId = appendField(builder, field, 'hello');
    const content = createEmittedFieldState(builder, 'text');
    appendContent(builder, content, 'hello', [partId]);

    const emittedFieldPlacements = collectEmittedFieldPlacements('changed', content);
    const finalizer = createFieldReferencer(builder, emittedFieldPlacements);
    expect(emittedFieldPlacements).toEqual(new Map());
    expect(await finalizer.referenceField('hello', field)).toBe('hello');
  });

  it('rejects a second output occurrence for the same SSE atom', () => {
    const builder = createReferenceBuilder();
    const field = createFieldState('text');
    const partId = appendField(builder, field, 'same');
    const first = createEmittedFieldState(builder, 'text');
    const second = createEmittedFieldState(builder, 'text');
    appendContent(builder, first, 'same', [partId]);

    expect(() => appendContent(builder, second, 'same', [partId])).toThrowError('ReferenceBuilder part 0 has multiple output occurrences');
  });

  it('deduplicates equal final content hashes', async () => {
    const builder = createReferenceBuilder();
    const firstField = createFieldState('text');
    const secondField = createFieldState('text');
    const firstPart = appendField(builder, firstField, 'same');
    const secondPart = appendField(builder, secondField, 'same');
    const firstContent = createEmittedFieldState(builder, 'text');
    const secondContent = createEmittedFieldState(builder, 'text');
    appendContent(builder, firstContent, 'same', [firstPart]);
    appendContent(builder, secondContent, 'same', [secondPart]);
    const emittedFieldPlacements = new Map([
      ...collectEmittedFieldPlacements('same', firstContent),
      ...collectEmittedFieldPlacements('same', secondContent),
    ]);
    const finalizer = createFieldReferencer(builder, emittedFieldPlacements);
    const firstReference = await finalizer.referenceField('same', firstField);
    const secondReference = await finalizer.referenceField('same', secondField);

    if (!(firstReference instanceof ContentReference) || !(secondReference instanceof ContentReference)) throw new Error('Expected thin references');
    expect(firstReference.parts).toEqual([0]);
    expect(secondReference.parts).toEqual([0]);
    expect(finalizer.referencedContentHashes).toHaveLength(1);
  });

  it('hashes UTF-16 code units without normalizing isolated surrogates', async () => {
    const text = '\ud800a\udc00?';
    expect(await hashRoundTripContent(text)).not.toEqual(await hashRoundTripContent(text.toWellFormed()));
  });

  it('finalizes nested assistant state without materializing sparse holes', async () => {
    const builder = createReferenceBuilder();
    const contentField = createFieldState('text');
    const argumentsField = createFieldState('text');
    const contentPart = appendField(builder, contentField, 'answer');
    const argumentsPart = appendField(builder, argumentsField, '{}');
    const content = createEmittedFieldState(builder, 'text');
    const argumentsContent = createEmittedFieldState(builder, 'text');
    appendContent(builder, content, 'answer', [contentPart]);
    appendContent(builder, argumentsContent, '{}', [argumentsPart]);
    const toolCalls: NonNullable<OpenAIChatCompletionsInputAssistantTurn['tool_calls']> = [];
    toolCalls.length = 2;
    toolCalls[1] = { id: 'call', type: 'function', function: { name: 'lookup', arguments: '{}' } };
    const turn: OpenAIChatCompletionsInputAssistantTurn = { role: 'assistant', name: 'assistant', content: 'answer', tool_calls: toolCalls };
    const fieldToolCalls: NonNullable<OpenAIChatCompletionsAssistantState<ReadFieldStates>['tool_calls']> = [];
    fieldToolCalls.length = 2;
    fieldToolCalls[1] = { function: { arguments: argumentsField } };
    const fieldState: OpenAIChatCompletionsAssistantState<ReadFieldStates> = { content: contentField, tool_calls: fieldToolCalls };
    const contentToolCalls: NonNullable<OpenAIChatCompletionsAssistantState<EmittedFieldStates>['tool_calls']> = [];
    contentToolCalls.length = 2;
    contentToolCalls[1] = { function: { arguments: argumentsContent } };
    const contentState: OpenAIChatCompletionsAssistantState<EmittedFieldStates> = { content, tool_calls: contentToolCalls };
    const finalized = await referenceAssistantTurn<'openaiChatCompletions'>(turn, fieldState, builder, collectEmittedFieldPlacements(turn, contentState));

    expect(finalized.targetTurn.name).toBe('assistant');
    expect(finalized.targetTurn.content).toBe('answer');
    expect(Object.hasOwn(finalized, 'referencedContentHashes')).toBe(false);
    const finalizedCalls = finalized.targetTurn.tool_calls;
    if (finalizedCalls === undefined) throw new Error('Expected finalized tool calls');
    expect(finalizedCalls).toHaveLength(2);
    expect(Object.hasOwn(finalizedCalls, 0)).toBe(false);
    expect(finalizedCalls[1]?.type === 'function' && finalizedCalls[1].function.arguments).toBe('{}');
  });

  it('omits referenced contents when every B field remains literal despite valid A views', async () => {
    const builder = createReferenceBuilder();
    const field = createFieldState('text');
    appendField(builder, field, 'literal B text');
    const content = createEmittedFieldState(builder, 'text');
    appendContent(builder, content, 'visible A text');
    const turn: OpenAIChatCompletionsInputAssistantTurn = { role: 'assistant', content: 'literal B text' };
    const fieldState: OpenAIChatCompletionsAssistantState<ReadFieldStates> = { content: field };
    const contentState: OpenAIChatCompletionsAssistantState<EmittedFieldStates> = { content };

    const finalized = await referenceAssistantTurn<'openaiChatCompletions'>(
      turn,
      fieldState,
      builder,
      collectEmittedFieldPlacements({ role: 'assistant', content: 'visible A text' }, contentState),
    );

    expect(finalized.targetTurn).toEqual(turn);
    expect(Object.hasOwn(finalized, 'referencedContentHashes')).toBe(false);
  });

  it('lists only referenced contents when other valid views stay literal', async () => {
    const builder = createReferenceBuilder();
    const referenced = createFieldState('text');
    const literal = createFieldState('text');
    const part = appendField(builder, referenced, 'referenced');
    appendField(builder, literal, 'literal B text');
    const referencedContent = createEmittedFieldState(builder, 'text');
    const literalContent = createEmittedFieldState(builder, 'text');
    appendContent(builder, referencedContent, 'referenced', [part]);
    appendContent(builder, literalContent, 'visible A text');
    const views = new Map([
      ...collectEmittedFieldPlacements('referenced', referencedContent),
      ...collectEmittedFieldPlacements('visible A text', literalContent),
    ]);

    const finalizer = createFieldReferencer(builder, views);

    expect(await finalizer.referenceField('referenced', referenced)).toBeInstanceOf(ContentReference);
    expect(await finalizer.referenceField('literal B text', literal)).toBe('literal B text');
    expect(finalizer.referencedContentHashes).toEqual([await hashRoundTripContent('referenced')]);
  });

  it('rejects a paired state whose container shape does not match the turn', async () => {
    const builder = createReferenceBuilder();
    const turn: OpenAIChatCompletionsInputAssistantTurn = { role: 'assistant', tool_calls: [] };
    const state: OpenAIChatCompletionsAssistantState<ReadFieldStates> = {};
    Reflect.set(state, 'tool_calls', {});

    await expect(referenceAssistantTurn<'openaiChatCompletions'>(turn, state, builder, new Map())).rejects.toThrow('ReferenceBuilder state object does not match its assistant turn');
  });

  it('creates slices across two A fields in UTF-16 coordinates', async () => {
    const builder = createReferenceBuilder();
    const field = createFieldState('text');
    const text = '\ud800a\udc00?';
    const firstText = text.slice(0, 2);
    const secondText = text.slice(2);
    const firstPart = appendField(builder, field, firstText);
    const secondPart = appendField(builder, field, secondText);
    const firstCarrier = `x${firstText}y`;
    const secondCarrier = `[${secondText}]`;
    const firstResolved = createEmittedFieldState(builder, 'text');
    const secondResolved = createEmittedFieldState(builder, 'text');
    appendContent(builder, firstResolved, 'x');
    appendContent(builder, firstResolved, firstText, [firstPart]);
    appendContent(builder, firstResolved, 'y');
    appendContent(builder, secondResolved, '[');
    appendContent(builder, secondResolved, secondText, [secondPart]);
    appendContent(builder, secondResolved, ']');
    const views = new Map([
      ...collectEmittedFieldPlacements(firstCarrier, firstResolved),
      ...collectEmittedFieldPlacements(secondCarrier, secondResolved),
    ]);
    const finalizer = createFieldReferencer(builder, views);
    const reference = await finalizer.referenceField(text, field);
    if (!(reference instanceof ContentReference)) throw new Error('Expected a thin reference');
    expect(reference.parts).toEqual([[0, 1, 3], [1, 1, 3]]);
  });

});

it('uses the final JSON text view to reference and restore a B object', async () => {
  const builder = createReferenceBuilder();
  const field = createFieldState('json');
  const json = '{"x":1}';
  const partId = appendField(builder, field, json);
  const content = createEmittedFieldState(builder, 'json');
  appendContent(builder, content, json, [partId]);
  const original = parseJSONObject(json);
  const finalizer = createFieldReferencer(builder, collectEmittedFieldPlacements(original, content));
  const reference = await finalizer.referenceField(original, field);

  expect(reference).toBeInstanceOf(ContentReference);
  if (!(reference instanceof ContentReference) || reference.kind !== 'json') throw new Error('Expected a JSON reference');
  const turn: AnthropicMessagesReferenceableAssistantTurn<ContentReference> = {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'call', name: 'lookup', input: reference }],
  };
  expect(await restoreAssistantTurn('anthropicMessages', [original], turn, finalizer.referencedContentHashes)).toEqual({
    ok: true,
    turn: { role: 'assistant', content: [{ type: 'tool_use', id: 'call', name: 'lookup', input: original }] },
  });
});

it('round-trips raw JSON numbers and keeps changed key order literal', async () => {
  const builder = createReferenceBuilder();
  const json = '{"n":9007199254740993}';
  const field = createFieldState('json');
  const partId = appendField(builder, field, json);
  const content = createEmittedFieldState(builder, 'json');
  appendContent(builder, content, json, [partId]);
  const original = parseJSONObject(json);
  const finalizer = createFieldReferencer(builder, collectEmittedFieldPlacements(original, content));
  const reference = await finalizer.referenceField(original, field);
  if (!(reference instanceof ContentReference) || reference.kind !== 'json') throw new Error('Expected a JSON reference');
  const turn: AnthropicMessagesReferenceableAssistantTurn<ContentReference> = { role: 'assistant', content: [{ type: 'tool_use', id: 'call', name: 'lookup', input: reference }] };
  const hydrated = await restoreAssistantTurn('anthropicMessages', [original], turn, finalizer.referencedContentHashes);
  expect(hydrated.ok).toBe(true);
  if (!hydrated.ok) throw new Error('Expected JSON hydration');
  expect(JSON.stringify(hydrated.turn.content[0])).toContain('9007199254740993');

  const reorderedField = createFieldState('json');
  const reorderedPart = appendField(builder, reorderedField, '{"a":1,"b":2}');
  const reorderedContent = createEmittedFieldState(builder, 'text');
  appendContent(builder, reorderedContent, '{"a":1,"b":2}', [reorderedPart]);
  const reorderedFinalizer = createFieldReferencer(builder, collectEmittedFieldPlacements('{"a":1,"b":2}', reorderedContent));
  const reorderedOriginal: IRJSONObject = { b: 2, a: 1 };
  expect(await reorderedFinalizer.referenceField(reorderedOriginal, reorderedField)).toBe(reorderedOriginal);
});

it('keeps JSON fields literal when their string turns do not restore the original object', async () => {
  const builder = createReferenceBuilder();
  const field = createFieldState('json');
  const partId = appendField(builder, field, '{"x":1}');
  const content = createEmittedFieldState(builder, 'text');
  appendContent(builder, content, '{"x":1}', [partId]);
  const original: IRJSONObject = { x: 2 };
  const finalizer = createFieldReferencer(builder, collectEmittedFieldPlacements('{"x":1}', content));

  expect(await finalizer.referenceField(original, field)).toBe(original);
  expect(finalizer.referencedContentHashes).toEqual([]);
});

it('keeps the original JSON object when the collected B text is incomplete', async () => {
  const builder = createReferenceBuilder();
  const field = createFieldState('json');
  const incomplete = '{"x":1';
  const partId = appendField(builder, field, incomplete);
  const content = createEmittedFieldState(builder, 'text');
  appendContent(builder, content, incomplete, [partId]);
  const original: IRJSONObject = { x: 1 };
  const finalizer = createFieldReferencer(builder, collectEmittedFieldPlacements(incomplete, content));

  expect(await finalizer.referenceField(original, field)).toBe(original);
});
