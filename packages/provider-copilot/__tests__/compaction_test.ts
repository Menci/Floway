import { expect, test } from 'vitest';

import { compactionResponse } from '../src/compaction.ts';
import type { OpenAIResponsesCompactionResultEx, CanonicalOpenAIResponsesInputItem, OpenAIResponsesResultEx } from '@floway-dev/protocols/openai-responses';

const generatedResult = (output: unknown[]): OpenAIResponsesResultEx =>
  ({
    id: 'resp_1',
    object: 'response',
    model: 'gpt-5.2-codex',
    output: output as OpenAIResponsesResultEx['output'],
    status: 'completed',
    incomplete_details: null,
    error: null,
    usage: { input_tokens: 10, output_tokens: 0, total_tokens: 10 },
  }) as OpenAIResponsesResultEx;

const compaction = { type: 'compaction', id: 'cmp_1', encrypted_content: 'BLOB' };

const shape = (result: OpenAIResponsesCompactionResultEx): string[] =>
  result.output.map(item => (item.type === 'compaction' ? 'compaction' : `${item.type}:${(item as { role?: string }).role}`));

test('keeps retained user/assistant/developer/system messages and appends the compaction item, absorbing tool/function items into the blob', () => {
  const input: CanonicalOpenAIResponsesInputItem[] = [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] },
    { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'lookup', arguments: '{}', status: 'completed' },
    { type: 'message', role: 'system', content: 'be nice' },
  ];
  // The trigger turn may also emit a stray assistant message; only the
  // compaction items survive, regardless of the generated assistant output.
  const result = compactionResponse(input, generatedResult([{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'stray' }] }, compaction]));

  expect(result.object).toBe('response.compaction');
  expect(shape(result)).toEqual(['message:user', 'message:assistant', 'message:system', 'compaction']);
  expect(result.output.at(-1)).toEqual(compaction);
});

test('throws when the trigger turn returned no compaction item', () => {
  expect(() => compactionResponse([], generatedResult([]))).toThrow(/no compaction output item/);
});

test('truncates retained messages newest-first to the 64k token budget', () => {
  // codex token heuristic is ceil(utf8_bytes / 4); 4 ASCII bytes ≈ 1 token.
  const oldest: CanonicalOpenAIResponsesInputItem = { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'x'.repeat(64_001 * 4) }] };
  const newest: CanonicalOpenAIResponsesInputItem = { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'recent' }] };
  const result = compactionResponse([oldest, newest], generatedResult([compaction]));

  // The oldest message alone exceeds the budget once the newest is kept, so it
  // drops entirely; only the recent message and the compaction blob remain.
  expect(result.output).toHaveLength(2);
  expect((result.output[0] as { role?: string }).role).toBe('user');
  expect((result.output[0] as { content?: unknown }).content).toEqual([{ type: 'input_text', text: 'recent' }]);
  expect(result.output[1]).toEqual(compaction);
});

test('input_image parts do not consume token budget', () => {
  // The token heuristic costs images at 0 — codex parity. A retained turn
  // dominated by an image must not push out earlier turns that would
  // otherwise have fit.
  const earlier: CanonicalOpenAIResponsesInputItem = { type: 'message', role: 'user', content: 'kept' };
  const newest: CanonicalOpenAIResponsesInputItem = {
    type: 'message',
    role: 'user',
    content: [
      // A 1 MiB base64 blob would be ~262_144 tokens by the utf8/4 heuristic
      // if charged; charging 0 means the earlier turn still survives.
      { type: 'input_image', image_url: `data:image/png;base64,${'A'.repeat(1_048_576)}`, detail: 'auto' },
    ],
  };
  const result = compactionResponse([earlier, newest], generatedResult([compaction]));

  // Both retained, plus the compaction blob.
  expect(result.output).toHaveLength(3);
  expect((result.output[0] as { role?: string }).role).toBe('user');
  expect((result.output[0] as { content: Array<{ text?: string }> }).content[0]?.text).toBe('kept');
  expect((result.output[1] as { content: Array<{ type: string }> }).content[0]?.type).toBe('input_image');
});
