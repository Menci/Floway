import { Tag } from 'cbor-x';
import { describe, expect, it } from 'vitest';

import type { IRJSONObject } from '../../../src/ir/types.ts';
import type { AnthropicMessagesThinAssistantTurn } from '../../../src/protocols/anthropic-messages/as-target/assistant-turn.ts';
import type { OpenAIChatCompletionsAssistantState, OpenAIChatCompletionsInputAssistantTurn } from '../../../src/protocols/openai-chat-completions/as-target/assistant-turn.ts';
import { hashRoundTripContent } from '../../../src/round-trip/replay-check.ts';
import type { ThinReference } from '../../../src/round-trip/thin/assistant-turn.ts';
import { THIN_TAGS } from '../../../src/round-trip/thin/assistant-turn.ts';
import { hydrateAssistantTurn } from '../../../src/round-trip/thin/hydrate.ts';
import {
  appendContent,
  appendField,
  collectContentViews,
  createReferenceBuilder,
  createContentState,
  createFieldState,
  createReferenceFinalizer,
  finalizeAssistantTurnReferences,
  type ContentStates,
  type FieldStates,
} from '../../../src/round-trip/thin/reference-builder.ts';
import { parseJSONObject } from '../../../src/shared/json/object.ts';

describe('ReferenceBuilder', () => {
  it('resolves every original SSE atom within one merged IR append', async () => {
    const builder = createReferenceBuilder();
    const field = createFieldState('text');
    const first = appendField(builder, field, 'hel');
    const second = appendField(builder, field, 'lo');
    const content = createContentState(builder, 'text');
    appendContent(builder, content, '[');
    appendContent(builder, content, 'hello', [first, second]);
    appendContent(builder, content, ']');
    const finalizer = await createReferenceFinalizer(builder, collectContentViews('[hello]', content));
    expect(await finalizer.finalizeField('hello', field)).toMatchObject({ value: [[0, 1, 6]] });
  });
  it('resolves B SSE atoms directly into one A content occurrence', async () => {
    const builder = createReferenceBuilder();
    const field = createFieldState('text');
    const first = appendField(builder, field, 'hel');
    const second = appendField(builder, field, 'lo');
    const content = createContentState(builder, 'text');

    appendContent(builder, content, '[');
    appendContent(builder, content, 'hel', [first]);
    appendContent(builder, content, 'lo', [second]);
    appendContent(builder, content, ']');

    const finalizer = await createReferenceFinalizer(builder, collectContentViews('[hello]', content));
    const reference = await finalizer.finalizeField('hello', field);

    if (!(reference instanceof Tag)) throw new Error('Expected a thin reference');
    expect(reference.tag).toBe(THIN_TAGS.text);
    expect(reference.value).toEqual([[0, 1, 6]]);
    expect(finalizer.referencedContents).toEqual([new Uint8Array([150, 39, 93, 50, 178, 83, 23, 204])]);
  });

  it('simplifies a reference covering the whole hashed content', async () => {
    const builder = createReferenceBuilder();
    const field = createFieldState('text');
    const first = appendField(builder, field, 'hel');
    const second = appendField(builder, field, 'lo');
    const content = createContentState(builder, 'text');
    appendContent(builder, content, 'hel', [first]);
    appendContent(builder, content, 'lo', [second]);

    const finalizer = await createReferenceFinalizer(builder, collectContentViews('hello', content));
    const reference = await finalizer.finalizeField('hello', field);

    if (!(reference instanceof Tag)) throw new Error('Expected a thin reference');
    expect(reference.value).toEqual([0]);
  });

  it('keeps the whole original field when any SSE atom is unresolved', async () => {
    const builder = createReferenceBuilder();
    const field = createFieldState('text');
    const first = appendField(builder, field, 'hel');
    appendField(builder, field, 'lo');
    const content = createContentState(builder, 'text');
    appendContent(builder, content, 'hel', [first]);

    const finalizer = await createReferenceFinalizer(builder, collectContentViews('hel', content));
    expect(await finalizer.finalizeField('hello', field)).toBe('hello');
    expect(finalizer.referencedContents).toEqual([]);
  });

  it('discards resolutions when the final input text view changed', async () => {
    const builder = createReferenceBuilder();
    const field = createFieldState('text');
    const partId = appendField(builder, field, 'hello');
    const content = createContentState(builder, 'text');
    appendContent(builder, content, 'hello', [partId]);

    const contentViews = collectContentViews('changed', content);
    const finalizer = await createReferenceFinalizer(builder, contentViews);
    expect(contentViews).toEqual(new Map());
    expect(await finalizer.finalizeField('hello', field)).toBe('hello');
  });

  it('rejects a second output occurrence for the same SSE atom', () => {
    const builder = createReferenceBuilder();
    const field = createFieldState('text');
    const partId = appendField(builder, field, 'same');
    const first = createContentState(builder, 'text');
    const second = createContentState(builder, 'text');
    appendContent(builder, first, 'same', [partId]);

    expect(() => appendContent(builder, second, 'same', [partId])).toThrowError('ReferenceBuilder part 0 has multiple output occurrences');
  });

  it('deduplicates equal final content hashes', async () => {
    const builder = createReferenceBuilder();
    const firstField = createFieldState('text');
    const secondField = createFieldState('text');
    const firstPart = appendField(builder, firstField, 'same');
    const secondPart = appendField(builder, secondField, 'same');
    const firstContent = createContentState(builder, 'text');
    const secondContent = createContentState(builder, 'text');
    appendContent(builder, firstContent, 'same', [firstPart]);
    appendContent(builder, secondContent, 'same', [secondPart]);
    const contentViews = new Map([
      ...collectContentViews('same', firstContent),
      ...collectContentViews('same', secondContent),
    ]);
    const finalizer = await createReferenceFinalizer(builder, contentViews);
    const firstReference = await finalizer.finalizeField('same', firstField);
    const secondReference = await finalizer.finalizeField('same', secondField);

    if (!(firstReference instanceof Tag) || !(secondReference instanceof Tag)) throw new Error('Expected thin references');
    expect(firstReference.value).toEqual([0]);
    expect(secondReference.value).toEqual([0]);
    expect(finalizer.referencedContents).toHaveLength(1);
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
    const content = createContentState(builder, 'text');
    const argumentsContent = createContentState(builder, 'text');
    appendContent(builder, content, 'answer', [contentPart]);
    appendContent(builder, argumentsContent, '{}', [argumentsPart]);
    const toolCalls: NonNullable<OpenAIChatCompletionsInputAssistantTurn['tool_calls']> = [];
    toolCalls.length = 2;
    toolCalls[1] = { id: 'call', type: 'function', function: { name: 'lookup', arguments: '{}' } };
    const turn: OpenAIChatCompletionsInputAssistantTurn = { role: 'assistant', name: 'assistant', content: 'answer', tool_calls: toolCalls };
    const fieldToolCalls: NonNullable<OpenAIChatCompletionsAssistantState<FieldStates>['tool_calls']> = [];
    fieldToolCalls.length = 2;
    fieldToolCalls[1] = { function: { arguments: argumentsField } };
    const fieldState: OpenAIChatCompletionsAssistantState<FieldStates> = { content: contentField, tool_calls: fieldToolCalls };
    const contentToolCalls: NonNullable<OpenAIChatCompletionsAssistantState<ContentStates>['tool_calls']> = [];
    contentToolCalls.length = 2;
    contentToolCalls[1] = { function: { arguments: argumentsContent } };
    const contentState: OpenAIChatCompletionsAssistantState<ContentStates> = { content, tool_calls: contentToolCalls };
    const finalized = await finalizeAssistantTurnReferences<'openaiChatCompletions'>(turn, fieldState, builder, collectContentViews(turn, contentState));

    expect(finalized.assistantTurn.name).toBe('assistant');
    expect(finalized.assistantTurn.content).toBe('answer');
    expect(Object.hasOwn(finalized, 'referencedContents')).toBe(false);
    const finalizedCalls = finalized.assistantTurn.tool_calls;
    if (finalizedCalls === undefined) throw new Error('Expected finalized tool calls');
    expect(finalizedCalls).toHaveLength(2);
    expect(Object.hasOwn(finalizedCalls, 0)).toBe(false);
    expect(finalizedCalls[1]?.type === 'function' && finalizedCalls[1].function.arguments).toBe('{}');
  });

  it('omits referenced contents when every B field remains literal despite valid A views', async () => {
    const builder = createReferenceBuilder();
    const field = createFieldState('text');
    appendField(builder, field, 'literal B text');
    const content = createContentState(builder, 'text');
    appendContent(builder, content, 'visible A text');
    const turn: OpenAIChatCompletionsInputAssistantTurn = { role: 'assistant', content: 'literal B text' };
    const fieldState: OpenAIChatCompletionsAssistantState<FieldStates> = { content: field };
    const contentState: OpenAIChatCompletionsAssistantState<ContentStates> = { content };

    const finalized = await finalizeAssistantTurnReferences<'openaiChatCompletions'>(
      turn,
      fieldState,
      builder,
      collectContentViews({ role: 'assistant', content: 'visible A text' }, contentState),
    );

    expect(finalized.assistantTurn).toEqual(turn);
    expect(Object.hasOwn(finalized, 'referencedContents')).toBe(false);
  });

  it('lists only referenced contents when other valid views stay literal', async () => {
    const builder = createReferenceBuilder();
    const referenced = createFieldState('text');
    const literal = createFieldState('text');
    const part = appendField(builder, referenced, 'referenced');
    appendField(builder, literal, 'literal B text');
    const referencedContent = createContentState(builder, 'text');
    const literalContent = createContentState(builder, 'text');
    appendContent(builder, referencedContent, 'referenced', [part]);
    appendContent(builder, literalContent, 'visible A text');
    const views = new Map([
      ...collectContentViews('referenced', referencedContent),
      ...collectContentViews('visible A text', literalContent),
    ]);

    const finalizer = await createReferenceFinalizer(builder, views);

    expect(await finalizer.finalizeField('referenced', referenced)).toBeInstanceOf(Tag);
    expect(await finalizer.finalizeField('literal B text', literal)).toBe('literal B text');
    expect(finalizer.referencedContents).toEqual([await hashRoundTripContent('referenced')]);
  });

  it('rejects a paired state whose container shape does not match the turn', async () => {
    const builder = createReferenceBuilder();
    const turn: OpenAIChatCompletionsInputAssistantTurn = { role: 'assistant', tool_calls: [] };
    const state: OpenAIChatCompletionsAssistantState<FieldStates> = {};
    Reflect.set(state, 'tool_calls', {});

    await expect(finalizeAssistantTurnReferences<'openaiChatCompletions'>(turn, state, builder, new Map())).rejects.toThrow('ReferenceBuilder state object does not match its assistant turn');
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
    const firstResolved = createContentState(builder, 'text');
    const secondResolved = createContentState(builder, 'text');
    appendContent(builder, firstResolved, 'x');
    appendContent(builder, firstResolved, firstText, [firstPart]);
    appendContent(builder, firstResolved, 'y');
    appendContent(builder, secondResolved, '[');
    appendContent(builder, secondResolved, secondText, [secondPart]);
    appendContent(builder, secondResolved, ']');
    const views = new Map([
      ...collectContentViews(firstCarrier, firstResolved),
      ...collectContentViews(secondCarrier, secondResolved),
    ]);
    const finalizer = await createReferenceFinalizer(builder, views);
    const reference = await finalizer.finalizeField(text, field);
    if (!(reference instanceof Tag)) throw new Error('Expected a thin reference');
    expect(reference.value).toEqual([[0, 1, 3], [1, 1, 3]]);
  });

});

it('uses the final JSON text view to reference and restore a B object', async () => {
  const builder = createReferenceBuilder();
  const field = createFieldState('json');
  const json = '{"x":1}';
  const partId = appendField(builder, field, json);
  const content = createContentState(builder, 'json');
  appendContent(builder, content, json, [partId]);
  const original = parseJSONObject(json);
  const finalizer = await createReferenceFinalizer(builder, collectContentViews(original, content));
  const reference = await finalizer.finalizeField(original, field);

  expect(reference).toBeInstanceOf(Tag);
  if (!(reference instanceof Tag) || reference.tag !== THIN_TAGS.json) throw new Error('Expected a JSON reference');
  const turn: AnthropicMessagesThinAssistantTurn<ThinReference> = {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'call', name: 'lookup', input: reference }],
  };
  expect(await hydrateAssistantTurn('anthropicMessages', [original], turn, finalizer.referencedContents)).toEqual({
    ok: true,
    turn: { role: 'assistant', content: [{ type: 'tool_use', id: 'call', name: 'lookup', input: original }] },
  });
});

it('round-trips raw JSON numbers and keeps changed key order literal', async () => {
  const builder = createReferenceBuilder();
  const json = '{"n":9007199254740993}';
  const field = createFieldState('json');
  const partId = appendField(builder, field, json);
  const content = createContentState(builder, 'json');
  appendContent(builder, content, json, [partId]);
  const original = parseJSONObject(json);
  const finalizer = await createReferenceFinalizer(builder, collectContentViews(original, content));
  const reference = await finalizer.finalizeField(original, field);
  if (!(reference instanceof Tag) || reference.tag !== THIN_TAGS.json) throw new Error('Expected a JSON reference');
  const turn: AnthropicMessagesThinAssistantTurn<ThinReference> = { role: 'assistant', content: [{ type: 'tool_use', id: 'call', name: 'lookup', input: reference }] };
  const hydrated = await hydrateAssistantTurn('anthropicMessages', [original], turn, finalizer.referencedContents);
  expect(hydrated.ok).toBe(true);
  if (!hydrated.ok) throw new Error('Expected JSON hydration');
  expect(JSON.stringify(hydrated.turn.content[0])).toContain('9007199254740993');

  const reorderedField = createFieldState('json');
  const reorderedPart = appendField(builder, reorderedField, '{"a":1,"b":2}');
  const reorderedContent = createContentState(builder, 'text');
  appendContent(builder, reorderedContent, '{"a":1,"b":2}', [reorderedPart]);
  const reorderedFinalizer = await createReferenceFinalizer(builder, collectContentViews('{"a":1,"b":2}', reorderedContent));
  const reorderedOriginal: IRJSONObject = { b: 2, a: 1 };
  expect(await reorderedFinalizer.finalizeField(reorderedOriginal, reorderedField)).toBe(reorderedOriginal);
});

it('keeps JSON fields literal when their string pieces do not restore the original object', async () => {
  const builder = createReferenceBuilder();
  const field = createFieldState('json');
  const partId = appendField(builder, field, '{"x":1}');
  const content = createContentState(builder, 'text');
  appendContent(builder, content, '{"x":1}', [partId]);
  const original: IRJSONObject = { x: 2 };
  const finalizer = await createReferenceFinalizer(builder, collectContentViews('{"x":1}', content));

  expect(await finalizer.finalizeField(original, field)).toBe(original);
  expect(finalizer.referencedContents).toEqual([]);
});

it('keeps the original JSON object when the collected B text is incomplete', async () => {
  const builder = createReferenceBuilder();
  const field = createFieldState('json');
  const incomplete = '{"x":1';
  const partId = appendField(builder, field, incomplete);
  const content = createContentState(builder, 'text');
  appendContent(builder, content, incomplete, [partId]);
  const original: IRJSONObject = { x: 1 };
  const finalizer = await createReferenceFinalizer(builder, collectContentViews(incomplete, content));

  expect(await finalizer.finalizeField(original, field)).toBe(original);
});
