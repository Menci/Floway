import { describe, expect, it, vi } from 'vitest';

import type { AnthropicMessagesAssistantState, AnthropicMessagesInputAssistantTurn } from '../../../src/protocols/anthropic-messages/as-target/assistant-turn.ts';
import { ContentReference } from '../../../src/round-trip/reference/assistant-turn.ts';
import { appendContent, appendField, collectContentViews, createContentState, createFieldState, createReferenceBuilder, type FieldStates } from '../../../src/round-trip/reference/reference-builder.ts';
import { finalizeAssistantTurnReferences } from '../../../src/round-trip/reference/reference-selection.ts';
import { restoreAssistantTurn } from '../../../src/round-trip/reference/restore.ts';
import type { TextPlacement } from '../../../src/round-trip/text-groups.ts';
import { hashRoundTripContent } from '../../../src/round-trip/turn-digest.ts';

const finalizeTexts = async (texts: readonly string[]) => {
  const builder = createReferenceBuilder();
  const contentState: NonNullable<AnthropicMessagesAssistantState<FieldStates>['content']> = [];
  const views = new Map<number, TextPlacement>();
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

describe('thin reference selection', () => {
  it.each(['hello', ' '.repeat(24)])('keeps %j literal when references cannot pay for the shared table', async text => {
    const result = await finalizeTexts([text]);
    expect(result.targetTurn).toEqual(result.turn);
    expect(result).not.toHaveProperty('referencedContentHashes');
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
      expect(result.targetTurn).toEqual(turn);
      expect(result).not.toHaveProperty('referencedContentHashes');
      expect(digest).not.toHaveBeenCalled();
    } finally {
      digest.mockRestore();
    }
  });

  it('keeps an equal-budget choice literal', async () => {
    const result = await finalizeTexts([' '.repeat(60)]);
    expect(result.targetTurn).toEqual(result.turn);
    expect(result).not.toHaveProperty('referencedContentHashes');
  });

  it('aggregates every use of one hash before paying its digest cost once', async () => {
    const texts = Array.from({ length: 12 }, () => 'hello there again');
    const result = await finalizeTexts(texts);
    expect(result.referencedContentHashes).toEqual([await hashRoundTripContent(texts[0])]);
    expect(result.targetTurn.content).toEqual(texts.map(() => ({ type: 'text', text: new ContentReference('text', [0]), citations: null })));
    expect(await restoreAssistantTurn('anthropicMessages', texts, result.targetTurn, result.referencedContentHashes)).toEqual({ ok: true, turn: result.turn });
  });

  it.each(['汉'.repeat(80), 'a'.repeat(80)])('selects equally long Unicode and ASCII text using format-independent lengths: %j', async text => {
    const result = await finalizeTexts([text]);
    expect(result.targetTurn.content).toEqual([{ type: 'text', text: new ContentReference('text', [0]), citations: null }]);
    expect(result.referencedContentHashes).toEqual([await hashRoundTripContent(text)]);
    expect(await restoreAssistantTurn('anthropicMessages', [text], result.targetTurn, result.referencedContentHashes)).toEqual({ ok: true, turn: result.turn });
  });

  it('drops unprofitable hashes and compacts the surviving index', async () => {
    const large = 'Large reference content. '.repeat(5);
    const small = Array.from({ length: 24 }, (_, index) => `entry ${index}`.padEnd(24, '.'));
    const result = await finalizeTexts([...small, large]);
    expect(result.referencedContentHashes).toEqual([await hashRoundTripContent(large)]);
    expect(result.targetTurn.content).toEqual([
      ...small.map(text => ({ type: 'text', text, citations: null })),
      { type: 'text', text: new ContentReference('text', [0]), citations: null },
    ]);
    expect(await restoreAssistantTurn('anthropicMessages', [...small, large], result.targetTurn, result.referencedContentHashes)).toEqual({ ok: true, turn: result.turn });
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
    expect(result.referencedContentHashes).toEqual([await hashRoundTripContent(text), await hashRoundTripContent('!')]);
    expect(result.targetTurn.content).toEqual([{ type: 'text', text: new ContentReference('text', [0, 1]), citations: null }]);
    expect(await restoreAssistantTurn('anthropicMessages', [text, '!'], result.targetTurn, result.referencedContentHashes)).toEqual({ ok: true, turn });
  });

  it.each([{ length: 50, referenced: false }, { length: 80, referenced: true }])('does not fund the selected table with rejected atomic fields: %j', async ({ length, referenced }) => {
    const builder = createReferenceBuilder();
    const shared = 'a'.repeat(length);
    const suffix = 'b'.repeat(30);
    const mixed = shared.slice(0, 30) + suffix;
    const wholeField = createFieldState('text');
    const mixedField = createFieldState('text');
    const wholeContent = createContentState(builder, 'text');
    const sharedContent = createContentState(builder, 'text');
    const suffixContent = createContentState(builder, 'text');
    appendContent(builder, wholeContent, shared, [appendField(builder, wholeField, shared)]);
    appendContent(builder, sharedContent, shared.slice(0, 30), [appendField(builder, mixedField, shared.slice(0, 30))]);
    appendContent(builder, sharedContent, shared.slice(30));
    appendContent(builder, suffixContent, suffix, [appendField(builder, mixedField, suffix)]);
    const turn: AnthropicMessagesInputAssistantTurn = { role: 'assistant', content: [{ type: 'text', text: shared, citations: null }, { type: 'text', text: mixed, citations: null }] };
    const views = new Map([...collectContentViews(shared, wholeContent), ...collectContentViews(shared, sharedContent), ...collectContentViews(suffix, suffixContent)]);
    const result = await finalizeAssistantTurnReferences<'anthropicMessages'>(turn, { content: [{ text: wholeField }, { text: mixedField }] }, builder, views);
    expect(result.targetTurn.content).toEqual([
      { type: 'text', text: referenced ? new ContentReference('text', [0]) : shared, citations: null },
      { type: 'text', text: mixed, citations: null },
    ]);
    if (referenced) expect(result.referencedContentHashes).toEqual([await hashRoundTripContent(shared)]);
    else expect(result).not.toHaveProperty('referencedContentHashes');
    expect(await restoreAssistantTurn('anthropicMessages', [shared, suffix], result.targetTurn, result.referencedContentHashes)).toEqual({ ok: true, turn });
  });
});
