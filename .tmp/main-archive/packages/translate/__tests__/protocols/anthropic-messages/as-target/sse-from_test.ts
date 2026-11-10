import { expect, test } from 'vitest';

import type { AnthropicMessagesAssistantState, AnthropicMessagesInputAssistantTurn } from '../../../../src/protocols/anthropic-messages/as-target/assistant-turn.ts';
import { irFromAnthropicMessages } from '../../../../src/protocols/anthropic-messages/as-target/sse-from.ts';
import { appendContent, collectContentViews, createContentState, createReferenceBuilder, type FieldStates } from '../../../../src/round-trip/reference/reference-builder.ts';
import { finalizeAssistantTurnReferences } from '../../../../src/round-trip/reference/reference-selection.ts';
import { fixtureFrames } from '../../../ir/translation-cases.ts';
import type { AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';

test('keeps native-shaped field state aligned through sparse block ordering and opaque slots', async () => {
  const ordinary = fixtureFrames('anthropic-messages', {});
  const start = ordinary.find(frame => frame.type === 'event' && frame.event.type === 'message_start');
  if (start === undefined) throw new Error('Fixture did not provide message_start');
  const end = ordinary.filter(frame => frame.type === 'event' && (frame.event.type === 'message_delta' || frame.event.type === 'message_stop'));
  const frames: ProtocolFrame<AnthropicMessagesStreamEventEx>[] = [
    start,
    eventFrame({ type: 'content_block_start', index: 7, content_block: { type: 'text', text: 'late', citations: [] } }),
    eventFrame({ type: 'content_block_stop', index: 7 }),
    eventFrame({ type: 'content_block_start', index: 4, content_block: { type: 'redacted_thinking', data: 'private' } }),
    eventFrame({ type: 'content_block_stop', index: 4 }),
    eventFrame({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: 'early', citations: [] } }),
    eventFrame({ type: 'content_block_stop', index: 1 }),
    ...end,
  ];
  const builder = createReferenceBuilder();
  const content = createContentState(builder, 'text');
  let captured: { turn: AnthropicMessagesInputAssistantTurn; state: AnthropicMessagesAssistantState<FieldStates> } | undefined;
  for await (const record of irFromAnthropicMessages((async function* () { yield* frames; })(), {
    roundTrip: { builder, onAssistantTurn: (_choice, turn, state) => { captured = { turn, state }; } },
  })) {
    if (record.type === 'write' && record.kind === 'append' && record.path.at(-1) === 'text') appendContent(builder, content, record.value, record.referencePieceIds);
  }
  if (captured === undefined) throw new Error('Native assistant turn was not collected');
  expect(captured.turn.content).toEqual([
    { type: 'text', text: 'early', citations: null },
    { type: 'redacted_thinking', data: 'private' },
    { type: 'text', text: 'late', citations: null },
  ]);
  expect(Object.hasOwn(captured.state.content ?? [], 1)).toBe(false);
  const result = await finalizeAssistantTurnReferences<'anthropicMessages'>(captured.turn, captured.state, builder, collectContentViews('lateearly', content));
  expect(result.targetTurn.content).toMatchObject([
    { text: 'early' },
    { type: 'redacted_thinking', data: 'private' },
    { text: 'late' },
  ]);
  expect(result).not.toHaveProperty('referencedContentHashes');
});
