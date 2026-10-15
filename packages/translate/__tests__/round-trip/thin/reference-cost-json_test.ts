import { Tag } from 'cbor-x';
import { expect, it } from 'vitest';

import type { IRJSONObject } from '../../../src/ir/types.ts';
import type { AnthropicMessagesInputAssistantTurn } from '../../../src/protocols/anthropic-messages/as-target/assistant-turn.ts';
import { THIN_TAGS } from '../../../src/round-trip/thin/assistant-turn.ts';
import { hydrateAssistantTurn } from '../../../src/round-trip/thin/hydrate.ts';
import { appendContent, appendField, collectContentViews, createContentState, createFieldState, createReferenceBuilder, finalizeAssistantTurnReferences } from '../../../src/round-trip/thin/reference-builder.ts';
import { rawJSON } from '../../../src/shared/json/raw-json.ts';

it.each<{ input: IRJSONObject; referenced: boolean }>([
  { input: { x: 1 }, referenced: false },
  { input: { text: 'Native tool arguments. '.repeat(8) }, referenced: true },
  { input: { amount: rawJSON.rawJSON('1.2300e+400') }, referenced: false },
  { input: { amount: rawJSON.rawJSON(`1e${'9'.repeat(80)}`) }, referenced: true },
])('costs JSON and raw numeric token tags rather than their stringified text: %j', async ({ input, referenced }) => {
  const builder = createReferenceBuilder();
  const field = createFieldState('json');
  const content = createContentState(builder, 'json');
  const text = JSON.stringify(input);
  appendContent(builder, content, text, [appendField(builder, field, text)]);
  const turn: AnthropicMessagesInputAssistantTurn = { role: 'assistant', content: [{ type: 'tool_use', id: 'call', name: 'lookup', input }] };
  const result = await finalizeAssistantTurnReferences<'anthropicMessages'>(turn, { content: [{ input: field }] }, builder, collectContentViews(input, content));
  if (!referenced) {
    expect(result.assistantTurn).toEqual(turn);
    expect(result).not.toHaveProperty('referencedContents');
  } else {
    expect(result.assistantTurn.content).toMatchObject([{ input: new Tag([0], THIN_TAGS.json) }]);
    expect(result.referencedContents).toHaveLength(1);
  }
  expect(await hydrateAssistantTurn('anthropicMessages', [input], result.assistantTurn, result.referencedContents)).toEqual({ ok: true, turn });
});
