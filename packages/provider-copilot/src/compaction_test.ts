import { expect, test } from 'vitest';

import type { ResponsesInputItem, ResponsesInputText, ResponsesResult } from '@floway-dev/protocols/responses';
import { compactionResponse } from '@floway-dev/provider';

const generatedResult = (output: unknown[]): ResponsesResult =>
  ({
    id: 'resp_1',
    object: 'response',
    model: 'gpt-5.2-codex',
    output: output as ResponsesResult['output'],
    status: 'completed',
    incomplete_details: null,
    error: null,
    usage: { input_tokens: 10, output_tokens: 0, total_tokens: 10 },
  }) as ResponsesResult;

const compaction = { type: 'compaction', id: 'cmp_1', encrypted_content: 'BLOB' };

const shape = (result: ResponsesResult): string[] =>
  result.output.map(item => (item.type === 'compaction' ? 'compaction' : `${item.type}:${(item as { role?: string }).role}`));

test('keeps retained user/assistant/developer/system messages and appends the compaction item, absorbing tool/function items into the blob', () => {
  const input: ResponsesInputItem[] = [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] },
    { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'lookup', arguments: '{}', status: 'completed' },
    { type: 'message', role: 'system', content: 'be nice' },
  ];
  // The trigger turn may also emit a stray assistant message; only the lone
  // compaction item survives, regardless of the generated assistant output.
  const result = compactionResponse(input, generatedResult([{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'stray' }] }, compaction]));

  expect(result.object).toBe('response.compaction');
  expect(shape(result)).toEqual(['message:user', 'message:assistant', 'message:system', 'compaction']);
  expect(result.output.at(-1)).toEqual(compaction);
});

test('normalizes every retained text part to input_text — assistant output_text included', () => {
  const input: ResponsesInputItem[] = [
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'reply', prompt_cache_breakpoint: { mode: 'explicit' } }],
    },
    { type: 'message', role: 'user', content: 'plain string' },
  ];
  const result = compactionResponse(input, generatedResult([compaction]));

  // Both retained messages echo with `input_text` parts, regardless of original part type.
  const assistantPart = (result.output[0] as { content: ResponsesInputText[] }).content[0];
  const userPart = (result.output[1] as { content: Array<{ type: string }> }).content[0];
  expect(assistantPart.type).toBe('input_text');
  expect(assistantPart.prompt_cache_breakpoint).toEqual({ mode: 'explicit' });
  expect(userPart.type).toBe('input_text');
});

test('assigns final random ids to retained messages instead of reusing input ids', () => {
  const result = compactionResponse(
    [{ type: 'message', id: 'msg_input', role: 'user', content: 'hello' }],
    generatedResult([compaction]),
  );

  const id = (result.output[0] as { id?: string }).id;
  expect(id).toMatch(/^msg_[0-9a-f]{32}$/);
  expect(id).not.toBe('msg_input');
});

test('throws when the trigger turn did not return exactly one compaction item', () => {
  expect(() => compactionResponse([], generatedResult([]))).toThrow(/exactly one compaction/);
  expect(() => compactionResponse([], generatedResult([compaction, { type: 'compaction', id: 'cmp_2', encrypted_content: 'X' }]))).toThrow(/exactly one compaction/);
});

test('truncates retained messages newest-first to the 64k token budget', () => {
  // codex token heuristic is ceil(utf8_bytes / 4); 4 ASCII bytes ≈ 1 token.
  const oldest: ResponsesInputItem = { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'x'.repeat(64_001 * 4) }] };
  const newest: ResponsesInputItem = { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'recent' }] };
  const result = compactionResponse([oldest, newest], generatedResult([compaction]));

  // The oldest message alone exceeds the budget once the newest is kept, so it
  // drops entirely; only the recent message and the compaction blob remain.
  expect(result.output).toHaveLength(2);
  expect((result.output[0] as { role?: string }).role).toBe('user');
  expect((result.output[0] as { content?: unknown }).content).toEqual([{ type: 'input_text', text: 'recent' }]);
  expect(result.output[1]).toEqual(compaction);
});

test('retains a message whose content is a plain string', () => {
  const result = compactionResponse([{ type: 'message', role: 'user', content: 'hi there' }], generatedResult([compaction]));
  expect(shape(result)).toEqual(['message:user', 'compaction']);
});

test('retains the newest message even when it alone exceeds the 64k budget', () => {
  // A single oversized message must still be retained — losing it would
  // strip the user's most recent turn from the compaction round-trip,
  // which would defeat the point of the call.
  const huge: ResponsesInputItem = { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'x'.repeat(64_001 * 4) }] };
  const result = compactionResponse([huge], generatedResult([compaction]));

  expect(result.output).toHaveLength(2);
  expect((result.output[0] as { role?: string }).role).toBe('user');
  expect(result.output[1]).toEqual(compaction);
});

test('the empty-message minimum-1-token charge prevents unbounded retention', () => {
  // Empty-text messages would otherwise consume zero budget; the
  // `Math.max(tokens, 1)` floor stops them from accumulating without bound.
  // 64_001 empty messages cannot all survive the budget.
  const empties: ResponsesInputItem[] = Array.from({ length: 64_001 }, () => ({ type: 'message', role: 'user', content: '' }));
  const result = compactionResponse(empties, generatedResult([compaction]));

  // The retained-message count is strictly under the input count.
  expect(result.output.length - 1).toBeLessThan(empties.length);
  // And exactly equals the budget (each empty message charges 1 token, so
  // the cap is hit at RETAINED_BUDGET_TOKENS kept entries).
  expect(result.output).toHaveLength(64_000 + 1);
});

test('preserves input_image parts verbatim in retained content', () => {
  // Native compact echoes images alongside text in retained messages; we
  // match that — `input_image` parts pass through `normalizeContent`
  // unchanged so the client can resend the multimodal turn as the next
  // input.
  const input: ResponsesInputItem[] = [{
    type: 'message',
    role: 'user',
    content: [
      { type: 'input_text', text: 'look at this' },
      { type: 'input_image', image_url: 'data:image/png;base64,AAA', detail: 'auto' },
      { type: 'input_text', text: 'and tell me' },
    ],
  }];
  const result = compactionResponse(input, generatedResult([compaction]));

  const retained = result.output[0] as unknown as { content: Array<Record<string, unknown>> };
  expect(retained.content).toEqual([
    { type: 'input_text', text: 'look at this' },
    { type: 'input_image', image_url: 'data:image/png;base64,AAA', detail: 'auto' },
    { type: 'input_text', text: 'and tell me' },
  ]);
});

test('preserves input_file parts', () => {
  const input: ResponsesInputItem[] = [{
    type: 'message',
    role: 'user',
    content: [{
      type: 'input_file',
      file_id: 'file_1',
    }],
  }];

  const result = compactionResponse(input, generatedResult([compaction]));

  expect((result.output[0] as unknown as { content: unknown[] }).content).toEqual([{
    type: 'input_file',
    file_id: 'file_1',
  }]);
});

test('preserves retained message phase', () => {
  const input: ResponsesInputItem[] = [{
    type: 'message',
    role: 'assistant',
    phase: 'commentary',
    content: [{ type: 'output_text', text: 'working' }],
  }];

  const result = compactionResponse(input, generatedResult([compaction]));

  expect((result.output[0] as unknown as { phase?: string }).phase).toBe('commentary');
});

test('input_image parts do not consume token budget', () => {
  // The token heuristic costs images at 0 — codex parity. A retained turn
  // dominated by an image must not push out earlier turns that would
  // otherwise have fit.
  const earlier: ResponsesInputItem = { type: 'message', role: 'user', content: 'kept' };
  const newest: ResponsesInputItem = {
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
