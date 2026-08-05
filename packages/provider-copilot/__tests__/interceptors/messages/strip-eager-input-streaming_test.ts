import { expect, test } from 'vitest';

import { withEagerInputStreamingStripped } from '../../../src/interceptors/messages/strip-eager-input-streaming.ts';
import type { MessagesBoundaryCtx } from '../../../src/interceptors/messages/types.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { MessagesPayload, MessagesStreamEvent } from '@floway-dev/protocols/messages';
import type { ExecuteResult } from '@floway-dev/provider';
import { stubProviderModel } from '@floway-dev/test-utils';

const invocation = (payload: MessagesPayload): MessagesBoundaryCtx => ({
  payload,
  headers: new Headers(),
  anthropicBeta: [],
  model: stubProviderModel({ endpoints: { messages: {} } }),
});

const terminal = (): Promise<ExecuteResult<ProtocolFrame<MessagesStreamEvent>>> => Promise.resolve({
  type: 'internal-error',
  status: 500,
  error: {
    type: 'internal_error',
    name: 'Error',
    message: 'unused terminal',
    stack: '',
    target_api: 'messages',
  },
});

test('withEagerInputStreamingStripped removes only the Copilot-incompatible tool extension', async () => {
  const sourceTool = {
    name: 'lookup',
    description: 'Lookup a value',
    input_schema: { type: 'object' },
    eager_input_streaming: true,
  };
  const payload = {
    model: 'claude-opus-4-7',
    max_tokens: 16,
    messages: [],
    tools: [sourceTool],
  } as MessagesPayload;
  const sourceTools = payload.tools;
  const ctx = invocation(payload);

  await withEagerInputStreamingStripped(ctx, {}, terminal);

  expect(ctx.payload.tools).toEqual([{
    name: 'lookup',
    description: 'Lookup a value',
    input_schema: { type: 'object' },
  }]);
  expect(ctx.payload.tools).not.toBe(sourceTools);
  expect(sourceTool.eager_input_streaming).toBe(true);
});

test('withEagerInputStreamingStripped preserves a payload with no tools', async () => {
  const payload: MessagesPayload = { model: 'claude-opus-4-7', max_tokens: 16, messages: [] };
  const ctx = invocation(payload);

  await withEagerInputStreamingStripped(ctx, {}, terminal);

  expect(ctx.payload).toBe(payload);
});
