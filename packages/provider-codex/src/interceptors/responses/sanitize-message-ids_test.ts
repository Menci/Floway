import { test } from 'vitest';

import { sanitizeMessageIds } from './sanitize-message-ids.ts';
import type { ResponsesBoundaryCtx } from './types.ts';
import type { ResponsesPayload, ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import type { ProviderStreamResult } from '@floway-dev/provider';
import { assertEquals, stubUpstreamModel } from '@floway-dev/test-utils';

const stubRequest = {};

const okEvents = (): Promise<ProviderStreamResult<ResponsesStreamEvent>> =>
  Promise.resolve({ ok: true, events: (async function* () {})(), modelKey: 'test', headers: new Headers() });

const invocation = (payload: ResponsesPayload): ResponsesBoundaryCtx => ({
  payload,
  headers: new Headers(),
  model: stubUpstreamModel({ endpoints: { responses: {} } }),
});

test('drops Codex review rollout message ids while preserving review content', async () => {
  const ctx = invocation({
    model: 'gpt-test',
    input: [
      {
        type: 'message',
        id: 'review_rollout_user',
        role: 'user',
        content: [{ type: 'input_text', text: 'User initiated a review task.' }],
      },
      {
        type: 'message',
        id: 'review_rollout_assistant',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'review assistant output' }],
      },
    ],
  });

  await sanitizeMessageIds(ctx, stubRequest, okEvents);

  assertEquals(ctx.payload.input, [
    {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'User initiated a review task.' }],
    },
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'review assistant output' }],
    },
  ]);
});

test('drops invalid ids from typeless easy input messages', async () => {
  const ctx = invocation({
    model: 'gpt-test',
    input: [
      {
        id: 'review_rollout_user',
        role: 'user',
        content: 'User initiated a review task.',
      },
    ],
  } as unknown as ResponsesPayload);

  await sanitizeMessageIds(ctx, stubRequest, okEvents);

  assertEquals(ctx.payload.input, [
    {
      role: 'user',
      content: 'User initiated a review task.',
    },
  ]);
});

test('keeps Codex/OpenAI message ids intact', async () => {
  const ctx = invocation({
    model: 'gpt-test',
    input: [
      { type: 'message', id: 'msg_valid', role: 'user', content: 'hello' },
    ],
  });

  await sanitizeMessageIds(ctx, stubRequest, okEvents);

  assertEquals(ctx.payload.input, [
    { type: 'message', id: 'msg_valid', role: 'user', content: 'hello' },
  ]);
});

test('keeps non-message item ids intact', async () => {
  const ctx = invocation({
    model: 'gpt-test',
    input: [
      {
        type: 'function_call',
        id: 'call_local',
        call_id: 'call_1',
        name: 'tool',
        arguments: '{}',
        status: 'completed',
      },
    ],
  });

  await sanitizeMessageIds(ctx, stubRequest, okEvents);

  assertEquals(ctx.payload.input, [
    {
      type: 'function_call',
      id: 'call_local',
      call_id: 'call_1',
      name: 'tool',
      arguments: '{}',
      status: 'completed',
    },
  ]);
});

test('leaves string input untouched', async () => {
  const ctx = invocation({ model: 'gpt-test', input: 'hello' });

  await sanitizeMessageIds(ctx, stubRequest, okEvents);

  assertEquals(ctx.payload, { model: 'gpt-test', input: 'hello' });
});
