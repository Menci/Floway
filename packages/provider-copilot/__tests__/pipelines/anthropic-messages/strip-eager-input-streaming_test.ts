import { expect, test } from 'vitest';

import { stripEagerInputStreaming } from '../../../src/pipelines/anthropic-messages/strip-eager-input-streaming.ts';
import { runStage } from '../stage.ts';

test('Copilot strips eager_input_streaming from Anthropic tool declarations and keeps the remaining fields', async () => {
  const tool = { name: 'lookup', input_schema: { type: 'object' as const }, eager_input_streaming: true };
  const result = await runStage(stripEagerInputStreaming, 'anthropicMessages', {
    payload: { model: 'claude-test', max_tokens: 16, messages: [], tools: [tool] },
  });
  expect(result.payload.tools).toEqual([{ name: 'lookup', input_schema: { type: 'object' } }]);
  expect(tool.eager_input_streaming).toBe(true);
});
