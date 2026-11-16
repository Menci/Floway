import { expect, test, vi } from 'vitest';

import { withLegacyMaxTokens } from '../../../../../src/data-plane/chat/openai-chat-completions/interceptors/legacy-max-tokens.ts';
import type { OpenAIChatCompletionsInvocation } from '../../../../../src/data-plane/chat/openai-chat-completions/interceptors/types.ts';
import { mockChatGatewayCtx } from '../../../../test-utils/gateway-ctx.ts';
import type { OpenAIChatCompletionsPayload } from '@floway-dev/protocols/openai-chat-completions';
import { eventResult } from '@floway-dev/provider';
import { stubModelCandidate, testTelemetryModelIdentity } from '@floway-dev/test-utils';

const invocation = (limits: Partial<OpenAIChatCompletionsPayload>, enabled = true): OpenAIChatCompletionsInvocation => ({
  payload: { model: 'm', messages: [], stream: true, ...limits },
  targetApi: 'openaiChatCompletions',
  candidate: stubModelCandidate({ enabledFlags: new Set(enabled ? ['openai-chat-completions-legacy-max-tokens'] : []) }),
  headers: new Headers(),
});

const result = () => eventResult((async function* () {})(), testTelemetryModelIdentity);

test.each([
  { limits: {}, expected: {} },
  { limits: { max_completion_tokens: 128000 }, expected: { max_tokens: 128000 } },
  { limits: { max_completion_tokens: 0 }, expected: { max_tokens: 0 } },
  { limits: { max_completion_tokens: null }, expected: { max_tokens: null } },
  { limits: { max_tokens: 32 }, expected: { max_tokens: 32 } },
  { limits: { max_tokens: 32, max_completion_tokens: 64 }, expected: { max_tokens: 64 } },
  { limits: { max_tokens: 32, max_completion_tokens: 0 }, expected: { max_tokens: 0 } },
  { limits: { max_tokens: 32, max_completion_tokens: null }, expected: { max_tokens: null } },
])('Floway legacy compatibility sends one cap for $limits', async ({ limits, expected }) => {
  const ctx = invocation(limits);
  const original = ctx.payload;
  const next = result();
  const run = vi.fn(async () => {
    expect(ctx.payload).toEqual({ model: 'm', messages: [], stream: true, ...expected });
    expect(ctx.payload).not.toHaveProperty('max_completion_tokens');
    return next;
  });
  expect(await withLegacyMaxTokens(ctx, mockChatGatewayCtx(), run)).toBe(next);
  expect(run).toHaveBeenCalledTimes(1);
  expect(original).toEqual({ model: 'm', messages: [], stream: true, ...limits });
});

test('Floway leaves the native request untouched without the legacy flag', async () => {
  const ctx = invocation({ max_completion_tokens: 128000 }, false);
  const original = ctx.payload;
  await withLegacyMaxTokens(ctx, mockChatGatewayCtx(), async () => result());
  expect(ctx.payload).toBe(original);
});

test('Floway defers the legacy rename until Chat is the final target', async () => {
  const ctx: OpenAIChatCompletionsInvocation = {
    ...invocation({ max_completion_tokens: 128000 }), targetApi: 'openaiResponses',
  };
  const original = ctx.payload;
  await withLegacyMaxTokens(ctx, mockChatGatewayCtx(), async () => result());
  expect(ctx.payload).toBe(original);
});

test('Floway propagates the original downstream failure without retrying', async () => {
  const ctx = invocation({ max_completion_tokens: 128000 });
  const failure = new Error('upstream failed');
  const run = vi.fn(async () => { throw failure; });
  await expect(withLegacyMaxTokens(ctx, mockChatGatewayCtx(), run)).rejects.toBe(failure);
  expect(run).toHaveBeenCalledTimes(1);
});
