import { expect, test } from 'vitest';

import { anthropicFacts, anthropicPayload } from './fixtures.ts';
import { normalizeEmptyToolsToolChoice } from '../../../../../src/data-plane/chat/anthropic-messages/stages/normalize-empty-tools-tool-choice.ts';
import { runChatStage } from '../../../../test-utils/chat-pipeline.ts';

test('rewrites an explicit empty tool list to Anthropic tool_choice none', async () => {
  const { outcome } = await runChatStage({
    stage: normalizeEmptyToolsToolChoice,
    facts: anthropicFacts(anthropicPayload({ tools: [], tool_choice: { type: 'auto' } }), {
      enabledFlags: ['empty-tools-tool-choice-none'],
    }),
    next: facts => facts['request.payload'],
  });
  expect(outcome).toMatchObject({ tools: [], tool_choice: { type: 'none' } });
});

test('leaves missing, non-empty and unflagged tool inventories unchanged', async () => {
  for (const [payload, flags] of [
    [anthropicPayload({ tool_choice: { type: 'auto' } }), ['empty-tools-tool-choice-none']],
    [anthropicPayload({ tools: [{ name: 'lookup', input_schema: { type: 'object' } }], tool_choice: { type: 'auto' } }), ['empty-tools-tool-choice-none']],
    [anthropicPayload({ tools: [], tool_choice: { type: 'auto' } }), []],
  ] as const) {
    const { outcome } = await runChatStage({
      stage: normalizeEmptyToolsToolChoice,
      facts: anthropicFacts(payload, { enabledFlags: flags }),
      next: facts => facts['request.payload'],
    });
    expect(outcome.tool_choice).toEqual({ type: 'auto' });
  }
});
