import { Tag } from 'cbor-x';
import { describe, expect, it, vi } from 'vitest';

import type { AnthropicMessagesAssistantState, AnthropicMessagesInputAssistantTurn } from '../../../src/protocols/anthropic-messages/as-target/assistant-turn.ts';
import { encodeSidecarValue } from '../../../src/round-trip/codec.ts';
import { hashRoundTripContent } from '../../../src/round-trip/replay-check.ts';
import { THIN_TAGS } from '../../../src/round-trip/thin/assistant-turn.ts';
import { hydrateAssistantTurn } from '../../../src/round-trip/thin/hydrate.ts';
import { appendContent, appendField, collectContentViews, createContentState, createFieldState, createReferenceBuilder, finalizeAssistantTurnReferences, type FieldStates } from '../../../src/round-trip/thin/reference-builder.ts';

const finalizeTexts = async (texts: readonly string[]) => {
  const builder = createReferenceBuilder();
  const contentState: NonNullable<AnthropicMessagesAssistantState<FieldStates>['content']> = [];
  const views = new Map<number, string>();
  for (const text of texts) {
    const field = createFieldState('text');
    const content = createContentState(builder, 'text');
    const part = appendField(builder, field, text);
    appendContent(builder, content, text, [part]);
    contentState.push({ text: field });
    for (const [id, view] of collectContentViews(text, content)) views.set(id, view);
  }
  const turn: AnthropicMessagesInputAssistantTurn = { role: 'assistant', content: texts.map(text => ({ type: 'text', text, citations: null })) };
  return { turn, ...await finalizeAssistantTurnReferences<'anthropicMessages'>(turn, { content: contentState }, builder, views) };
};

describe('thin reference byte costs', () => {
  it.each(['hello', ' '.repeat(24)])('keeps %j literal when references cannot pay for the shared table', async text => {
    const result = await finalizeTexts([text]);
    expect(result.assistantTurn).toEqual(result.turn);
    expect(result).not.toHaveProperty('referencedContents');
  });

  it('skips hashing a large A field when its B reference cannot beat the literal', async () => {
    const builder = createReferenceBuilder();
    const field = createFieldState('text');
    const content = createContentState(builder, 'text');
    const prefix = 'Large A content. '.repeat(100);
    appendContent(builder, content, prefix);
    appendContent(builder, content, 'hello', [appendField(builder, field, 'hello')]);
    const turn: AnthropicMessagesInputAssistantTurn = { role: 'assistant', content: [{ type: 'text', text: 'hello', citations: null }] };
    const digest = vi.spyOn(crypto.subtle, 'digest');
    try {
      const result = await finalizeAssistantTurnReferences<'anthropicMessages'>(turn, { content: [{ text: field }] }, builder, collectContentViews(`${prefix}hello`, content));
      expect(result.assistantTurn).toEqual(turn);
      expect(result).not.toHaveProperty('referencedContents');
      expect(digest).not.toHaveBeenCalled();
    } finally {
      digest.mockRestore();
    }
  });

  it('keeps an equal-cost choice literal', async () => {
    const referenceCost = encodeSidecarValue(new Tag([0], THIN_TAGS.text)).byteLength
      + encodeSidecarValue({ referencedContents: [new Uint8Array(8)] }).byteLength - encodeSidecarValue({}).byteLength;
    const text = Array.from({ length: 128 }, (_, index) => ' '.repeat(index)).find(value => encodeSidecarValue(value).byteLength === referenceCost);
    if (text === undefined) throw new Error('Expected an equal-cost text fixture');
    const result = await finalizeTexts([text]);
    expect(result.assistantTurn).toEqual(result.turn);
    expect(result).not.toHaveProperty('referencedContents');
  });

  it('aggregates every use of one hash before paying its digest cost once', async () => {
    const texts = Array.from({ length: 12 }, () => 'hello there');
    const result = await finalizeTexts(texts);
    expect(result.referencedContents).toEqual([await hashRoundTripContent(texts[0])]);
    expect(result.assistantTurn.content).toEqual(texts.map(() => ({ type: 'text', text: new Tag([0], THIN_TAGS.text), citations: null })));
    expect(await hydrateAssistantTurn('anthropicMessages', texts, result.assistantTurn, result.referencedContents)).toEqual({ ok: true, turn: result.turn });
  });

  it.each(['汉字汉字', '\ud800'.repeat(4)])('uses encoded Unicode bytes instead of JavaScript string length for %j', async text => {
    const unicode = await finalizeTexts(Array.from({ length: 12 }, () => text));
    const ascii = await finalizeTexts(Array.from({ length: 12 }, () => 'abcd'));
    expect(unicode.referencedContents).toHaveLength(1);
    expect(unicode.assistantTurn.content).toEqual(Array.from({ length: 12 }, () => ({ type: 'text', text: new Tag([0], THIN_TAGS.text), citations: null })));
    expect(ascii.assistantTurn).toEqual(ascii.turn);
    expect(ascii).not.toHaveProperty('referencedContents');
  });

  it('costs canonical Base64 using the same binary tag as the sidecar codec', async () => {
    const text = btoa('binary payload with bytes 1234');
    expect(text).toHaveLength(40);
    const result = await finalizeTexts([text]);
    expect(result.assistantTurn).toEqual(result.turn);
    expect(result).not.toHaveProperty('referencedContents');
  });

  it('drops unprofitable hashes and compacts a surviving two-byte provisional index', async () => {
    const large = 'Large reference content. '.repeat(5);
    const small = Array.from({ length: 24 }, (_, index) => `entry ${index}`);
    const result = await finalizeTexts([...small, large]);
    expect(result.referencedContents).toEqual([await hashRoundTripContent(large)]);
    expect(result.assistantTurn.content).toEqual([
      ...small.map(text => ({ type: 'text', text, citations: null })),
      { type: 'text', text: new Tag([0], THIN_TAGS.text), citations: null },
    ]);
    expect(await hydrateAssistantTurn('anthropicMessages', [...small, large], result.assistantTurn, result.referencedContents)).toEqual({ ok: true, turn: result.turn });
  });

  it('selects the hashes of one atomic mixed reference together after merging adjacent ranges', async () => {
    const builder = createReferenceBuilder();
    const field = createFieldState('text');
    const first = createContentState(builder, 'text');
    const second = createContentState(builder, 'text');
    const text = 'One long native string. '.repeat(5);
    const middle = Math.floor(text.length / 2);
    const left = appendField(builder, field, text.slice(0, middle));
    const right = appendField(builder, field, text.slice(middle));
    const suffix = appendField(builder, field, '!');
    appendContent(builder, first, text.slice(0, middle), [left]);
    appendContent(builder, first, text.slice(middle), [right]);
    appendContent(builder, second, '!', [suffix]);
    const turn: AnthropicMessagesInputAssistantTurn = { role: 'assistant', content: [{ type: 'text', text: `${text}!`, citations: null }] };
    const views = new Map([...collectContentViews(text, first), ...collectContentViews('!', second)]);
    const result = await finalizeAssistantTurnReferences<'anthropicMessages'>(turn, { content: [{ text: field }] }, builder, views);
    expect(result.referencedContents).toEqual([await hashRoundTripContent(text), await hashRoundTripContent('!')]);
    expect(result.assistantTurn.content).toEqual([{ type: 'text', text: new Tag([0, 1], THIN_TAGS.text), citations: null }]);
    expect(await hydrateAssistantTurn('anthropicMessages', [text, '!'], result.assistantTurn, result.referencedContents)).toEqual({ ok: true, turn });
  });
});
