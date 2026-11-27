import { expect, test } from 'vitest';

import { guardToolArgumentWhitespace } from '../../../src/pipelines/openai-responses/guard-tool-argument-whitespace.ts';
import { MAX_CONSECUTIVE_WHITESPACE } from '../../../src/pipelines/shared/whitespace-overflow.ts';
import { inspectStages } from '../inspect.ts';
import type { OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

const argsDelta = (outputIndex: number, delta: string): OpenAIResponsesStreamEventEx => ({
  type: 'response.function_call_arguments.delta',
  item_id: `fc_${outputIndex}`,
  output_index: outputIndex,
  delta,
}) as OpenAIResponsesStreamEventEx;

test('hands on a protocol failure when one output index exceeds the whitespace limit', async () => {
  const args = '\n'.repeat(MAX_CONSECUTIVE_WHITESPACE);
  const first = argsDelta(0, args);
  const second = argsDelta(1, args);
  const result = await inspectStages('openaiResponses', guardToolArgumentWhitespace, { payload: { model: 'test-model', input: [] } },
    ({ stream }) => ({ kind: 'stream', stream: stream([first, second, argsDelta(0, '\n'), argsDelta(0, 'later')]) }));
  expect(result.items).toEqual([
    { ok: true, value: first },
    { ok: true, value: second },
    { ok: false, error: { kind: 'protocol', cause: expect.objectContaining({ message: expect.stringContaining('whitespace') }) } },
  ]);
});
