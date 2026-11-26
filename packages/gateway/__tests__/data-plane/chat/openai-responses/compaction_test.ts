import { expect, test, vi } from 'vitest';

import {
  decryptOpenAIResponsesCompaction,
  expandShimCompactionItems,
  simulateOpenAIResponsesCompaction,
  SUMMARY_PREFIX,
  type OpenAIResponsesCompactionTurn,
} from '../../../../src/data-plane/chat/openai-responses/compaction.ts';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesOutputItemEx, OpenAIResponsesResultEx } from '@floway-dev/protocols/openai-responses';

const response = (output: OpenAIResponsesOutputItemEx[], status: OpenAIResponsesResultEx['status'] = 'completed'): OpenAIResponsesResultEx => ({
  id: 'resp_upstream', object: 'response', model: 'model', output, status,
  error: null, incomplete_details: status === 'incomplete' ? { reason: 'max_output_tokens' } : null,
  usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
});
const text = (value: string): OpenAIResponsesOutputItemEx => ({
  id: 'msg_1', type: 'message', role: 'assistant', status: 'completed',
  content: [{ type: 'output_text', text: value, annotations: [] }],
});
const turn = (result: OpenAIResponsesResultEx): OpenAIResponsesCompactionTurn => ({
  call: Promise.resolve(), response: { 'response.http': null }, outcome: { kind: 'result', result },
});

test('compact retries a textless turn with the system prompt and combines reported usage', async () => {
  const first = turn(response([]));
  const fallback = turn(response([text('fixture summary')], 'incomplete'));
  const generate = vi.fn<(request: CanonicalOpenAIResponsesPayload) => Promise<OpenAIResponsesCompactionTurn>>()
    .mockResolvedValueOnce(first).mockResolvedValueOnce(fallback);
  const drop = vi.fn();
  const warn = vi.fn();
  const history = { type: 'message' as const, role: 'user' as const, content: 'original' };
  const result = await simulateOpenAIResponsesCompaction({
    model: 'model', instructions: 'retain these', input: [history, { type: 'compaction_trigger' }],
  }, generate, drop, warn);
  expect(generate).toHaveBeenCalledTimes(2);
  expect(generate.mock.calls[0]?.[0]).toMatchObject({ store: false, input: [history, { type: 'message', role: 'user' }] });
  expect(generate.mock.calls[1]?.[0]).toMatchObject({
    instructions: 'retain these',
    input: [{ type: 'message', role: 'system' }, history, { type: 'message', role: 'user' }],
  });
  expect(drop).toHaveBeenCalledExactlyOnceWith(first);
  expect(warn).toHaveBeenCalledTimes(1);
  if (result.outcome.kind !== 'result') throw new Error('Expected compact output');
  expect(result.outcome.result).toMatchObject({
    object: 'response.compaction', output: [{ type: 'compaction' }], status: 'incomplete',
    usage: { input_tokens: 20, output_tokens: 40, total_tokens: 60 },
  });
  const replay = expandShimCompactionItems({ model: 'model', input: result.outcome.result.output as CanonicalOpenAIResponsesPayload['input'] });
  expect(replay.input).toEqual([{ type: 'message', role: 'user', content: [{ type: 'input_text', text: `${SUMMARY_PREFIX}\nfixture summary` }] }]);
});

test('native compact decryption replays each opaque item and preserves its original output position', async () => {
  const passthrough = text('plain');
  const nativeItem = { type: 'compaction' as const, id: 'cmp_a', encrypted_content: 'upstream-opaque' };
  const native = turn(response([passthrough, nativeItem]));
  const replay = turn(response([text('decoded native summary')]));
  const generate = vi.fn<(request: CanonicalOpenAIResponsesPayload) => Promise<OpenAIResponsesCompactionTurn>>().mockResolvedValue(replay);
  const drop = vi.fn();
  const result = await decryptOpenAIResponsesCompaction(native, 'model', generate, drop);
  expect(generate).toHaveBeenCalledTimes(1);
  expect(generate.mock.calls[0]?.[0].input[1]).toBe(nativeItem);
  expect(drop).toHaveBeenCalledExactlyOnceWith(replay);
  if (result.outcome.kind !== 'result') throw new Error('Expected decrypted output');
  expect(result.outcome.result.output[0]).toBe(passthrough);
  expect(result.outcome.result.output[1]).toMatchObject({ type: 'compaction', id: nativeItem.id, encrypted_content: expect.any(String) });
  expect(result.outcome.result.output[1]).not.toEqual(nativeItem);
  expect(expandShimCompactionItems({ input: [nativeItem] }).input[0]).toBe(nativeItem);
});
