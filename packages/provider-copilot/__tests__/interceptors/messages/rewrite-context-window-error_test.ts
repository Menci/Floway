import { expect, test } from 'vitest';

import { rewriteContextWindowError } from '../../../src/interceptors/messages/rewrite-context-window-error.ts';
import type { MessagesBoundaryCtx } from '../../../src/interceptors/messages/types.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import { buildPromptTooLongBody, type MessagesStreamEvent } from '@floway-dev/protocols/messages';
import type { ExecuteResult } from '@floway-dev/provider';
import { stubProviderModel } from '@floway-dev/test-utils';

const ctx = (): MessagesBoundaryCtx => ({
  payload: { model: 'claude-opus-4-7', max_tokens: 16, messages: [] },
  headers: new Headers(),
  anthropicBeta: [],
  model: stubProviderModel({ endpoints: { messages: {} } }),
});

const upstreamError = (text: string): ExecuteResult<ProtocolFrame<MessagesStreamEvent>> => ({
  type: 'api-error',
  source: 'upstream',
  status: 413,
  headers: new Headers({ 'content-type': 'text/plain', 'x-upstream': 'kept-only-with-original' }),
  body: new TextEncoder().encode(text),
});

test.each([
  'Request body is too large for model context window',
  '{"error":{"code":"context_length_exceeded"}}',
])('rewriteContextWindowError canonicalizes Copilot context failure %j', async text => {
  const result = await rewriteContextWindowError(ctx(), {}, () => Promise.resolve(upstreamError(text)));

  expect(result.type).toBe('api-error');
  if (result.type !== 'api-error') throw new Error('expected api-error');
  expect(result.status).toBe(400);
  expect([...result.headers]).toEqual([['content-type', 'application/json']]);
  expect(result.body).toEqual(buildPromptTooLongBody());
});

test('rewriteContextWindowError leaves unrelated and non-upstream failures byte-for-byte intact', async () => {
  const unrelated = upstreamError('ordinary rejection');
  const gateway = { ...upstreamError('context_length_exceeded'), source: 'gateway' as const };

  await expect(rewriteContextWindowError(ctx(), {}, () => Promise.resolve(unrelated))).resolves.toBe(unrelated);
  await expect(rewriteContextWindowError(ctx(), {}, () => Promise.resolve(gateway))).resolves.toBe(gateway);
});
