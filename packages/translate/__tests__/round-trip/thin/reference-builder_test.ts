import { Tag } from 'cbor-x';
import { describe, expect, it } from 'vitest';

import type { OpenAIChatCompletionsAssistantState, OpenAIChatCompletionsInputAssistantTurn } from '../../../src/protocols/openai-chat-completions/as-target/assistant-turn.ts';
import { hashRoundTripContent } from '../../../src/round-trip/replay-check.ts';
import { THIN_TAGS } from '../../../src/round-trip/thin/assistant-turn.ts';
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

describe('ReferenceBuilder', () => {
  it('resolves every original SSE atom within one merged IR append', async () => {
    const builder = createReferenceBuilder();
    const field = createFieldState();
    const first = appendField(builder, field, 'hel');
    const second = appendField(builder, field, 'lo');
    const content = createContentState(builder);
    appendContent(builder, content, '[');
    appendContent(builder, content, 'hello', [first, second]);
    appendContent(builder, content, ']');
    const finalizer = await createReferenceFinalizer(builder, collectContentViews('[hello]', content));
    expect(await finalizer.finalizeField('hello', field)).toMatchObject({ value: [[0, 1, 6]] });
  });
  it('resolves B SSE atoms directly into one A content occurrence', async () => {
    const builder = createReferenceBuilder();
    const field = createFieldState();
    const first = appendField(builder, field, 'hel');
    const second = appendField(builder, field, 'lo');
    const content = createContentState(builder);

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
    const field = createFieldState();
    const first = appendField(builder, field, 'hel');
    const second = appendField(builder, field, 'lo');
    const content = createContentState(builder);
    appendContent(builder, content, 'hel', [first]);
    appendContent(builder, content, 'lo', [second]);

    const finalizer = await createReferenceFinalizer(builder, collectContentViews('hello', content));
    const reference = await finalizer.finalizeField('hello', field);

    if (!(reference instanceof Tag)) throw new Error('Expected a thin reference');
    expect(reference.value).toEqual([0]);
  });

  it('keeps the whole original field when any SSE atom is unresolved', async () => {
    const builder = createReferenceBuilder();
    const field = createFieldState();
    const first = appendField(builder, field, 'hel');
    appendField(builder, field, 'lo');
    const content = createContentState(builder);
    appendContent(builder, content, 'hel', [first]);

    const finalizer = await createReferenceFinalizer(builder, collectContentViews('hel', content));
    expect(await finalizer.finalizeField('hello', field)).toBe('hello');
    expect(finalizer.referencedContents).toEqual([]);
  });

  it('discards resolutions when the final input text view changed', async () => {
    const builder = createReferenceBuilder();
    const field = createFieldState();
    const partId = appendField(builder, field, 'hello');
    const content = createContentState(builder);
    appendContent(builder, content, 'hello', [partId]);

    const contentViews = collectContentViews('changed', content);
    const finalizer = await createReferenceFinalizer(builder, contentViews);
    expect(contentViews).toEqual(new Map());
    expect(await finalizer.finalizeField('hello', field)).toBe('hello');
  });

  it('rejects a second output occurrence for the same SSE atom', () => {
    const builder = createReferenceBuilder();
    const field = createFieldState();
    const partId = appendField(builder, field, 'same');
    const first = createContentState(builder);
    const second = createContentState(builder);
    appendContent(builder, first, 'same', [partId]);

    expect(() => appendContent(builder, second, 'same', [partId])).toThrowError('ReferenceBuilder part 0 has multiple output occurrences');
  });

  it('deduplicates equal final content hashes', async () => {
    const builder = createReferenceBuilder();
    const firstField = createFieldState();
    const secondField = createFieldState();
    const firstPart = appendField(builder, firstField, 'same');
    const secondPart = appendField(builder, secondField, 'same');
    const firstContent = createContentState(builder);
    const secondContent = createContentState(builder);
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
    const contentField = createFieldState();
    const argumentsField = createFieldState();
    const contentPart = appendField(builder, contentField, 'answer');
    const argumentsPart = appendField(builder, argumentsField, '{}');
    const content = createContentState(builder);
    const argumentsContent = createContentState(builder);
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
    const field = createFieldState();
    appendField(builder, field, 'literal B text');
    const content = createContentState(builder);
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
    const referenced = createFieldState();
    const literal = createFieldState();
    const part = appendField(builder, referenced, 'referenced');
    appendField(builder, literal, 'literal B text');
    const referencedContent = createContentState(builder);
    const literalContent = createContentState(builder);
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
    const field = createFieldState();
    const text = '\ud800a\udc00?';
    const firstText = text.slice(0, 2);
    const secondText = text.slice(2);
    const firstPart = appendField(builder, field, firstText);
    const secondPart = appendField(builder, field, secondText);
    const firstCarrier = `x${firstText}y`;
    const secondCarrier = `[${secondText}]`;
    const firstResolved = createContentState(builder);
    const secondResolved = createContentState(builder);
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
