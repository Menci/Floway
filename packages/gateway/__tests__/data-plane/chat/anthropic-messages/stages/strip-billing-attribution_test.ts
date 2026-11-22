import { expect, test } from 'vitest';

import { anthropicFacts, anthropicPayload } from './fixtures.ts';
import { stripBillingAttribution } from '../../../../../src/data-plane/chat/anthropic-messages/stages/strip-billing-attribution.ts';
import { runChatStage } from '../../../../test-utils/chat-pipeline.ts';

test('scrubs billing lines and the Claude Code beta only when the candidate flag is enabled', async () => {
  const enabled = await runChatStage({
    stage: stripBillingAttribution,
    facts: anthropicFacts(anthropicPayload({
      system: 'x-anthropic-billing-header: token\ncch=deadbeef1234;\nbase rules',
    }), {
      enabledFlags: ['strip-billing-attribution'],
      anthropicBeta: ['claude-code-20250219', 'context-1m-2025-08-07'],
    }),
    next: facts => ({ payload: facts['request.payload'], beta: facts['request.anthropicBeta'] }),
  });
  expect(enabled.outcome).toEqual({
    payload: expect.objectContaining({ system: 'base rules' }),
    beta: ['context-1m-2025-08-07'],
  });

  const source = anthropicPayload({ system: 'x-anthropic-billing-header: token\ncch=deadbeef1234;' });
  const disabled = await runChatStage({
    stage: stripBillingAttribution,
    facts: anthropicFacts(source, { anthropicBeta: ['claude-code-20250219'] }),
    next: facts => facts['request.payload'],
  });
  expect(disabled.outcome).toBe(source);
});

test('removes the system field when every block is scrubbed', async () => {
  const { outcome } = await runChatStage({
    stage: stripBillingAttribution,
    facts: anthropicFacts(anthropicPayload({
      system: [
        { citations: null, type: 'text', text: 'x-anthropic-billing-header: token' },
        { citations: null, type: 'text', text: 'cch=deadbeef1234;' },
      ],
    }), { enabledFlags: ['strip-billing-attribution'] }),
    next: facts => facts['request.payload'],
  });
  expect('system' in outcome).toBe(false);
});
