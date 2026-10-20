import { expect, it } from 'vitest';

import type { IRJSONObject } from '../../../src/ir/types.ts';
import type { AnthropicMessagesInputAssistantTurn } from '../../../src/protocols/anthropic-messages/as-target/assistant-turn.ts';
import { ContentReference } from '../../../src/round-trip/reference/assistant-turn.ts';
import { appendContent, appendField, collectContentViews, createContentState, createFieldState, createReferenceBuilder } from '../../../src/round-trip/reference/reference-builder.ts';
import { finalizeAssistantTurnReferences } from '../../../src/round-trip/reference/reference-selection.ts';
import { restoreAssistantTurn } from '../../../src/round-trip/reference/restore.ts';
import { rawJSON } from '../../../src/shared/json/raw-json.ts';

it.each<{ input: IRJSONObject; referenced: boolean }>([
  { input: { x: 1 }, referenced: false },
  { input: { values: Array.from({ length: 10 }, () => null) }, referenced: false },
  { input: { values: Array.from({ length: 9 }, () => false) }, referenced: false },
  { input: { values: Array.from({ length: 20 }, () => 0) }, referenced: false },
  { input: { text: 'Native tool arguments. '.repeat(8) }, referenced: true },
  { input: { amount: rawJSON.rawJSON('1.2300e+400') }, referenced: false },
  { input: { amount: rawJSON.rawJSON(`1e${'9'.repeat(80)}`) }, referenced: true },
])('selects JSON references with a codec-independent semantic budget: %j', async ({ input, referenced }) => {
  const builder = createReferenceBuilder();
  const field = createFieldState('json');
  const content = createContentState(builder, 'json');
  const text = JSON.stringify(input);
  appendContent(builder, content, text, [appendField(builder, field, text)]);
  const turn: AnthropicMessagesInputAssistantTurn = { role: 'assistant', content: [{ type: 'tool_use', id: 'call', name: 'lookup', input }] };
  const result = await finalizeAssistantTurnReferences<'anthropicMessages'>(turn, { content: [{ input: field }] }, builder, collectContentViews(input, content));
  if (!referenced) {
    expect(result.targetTurn).toEqual(turn);
    expect(result).not.toHaveProperty('referencedContentHashes');
  } else {
    expect(result.targetTurn.content).toMatchObject([{ input: new ContentReference('json', [0]) }]);
    expect(result.referencedContentHashes).toHaveLength(1);
  }
  expect(await restoreAssistantTurn('anthropicMessages', [input], result.targetTurn, result.referencedContentHashes)).toEqual({ ok: true, turn });
});
