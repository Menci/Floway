import { test } from 'vitest';

import { withConnectionMismatchRetried } from './retry-connection-mismatch.ts';
import { initRepo } from '../../../../../repo/index.ts';
import { InMemoryRepo } from '../../../../../repo/memory.ts';
import { assertEquals, assertStringIncludes } from '../../../../../test-assert.ts';
import { stubProvider, stubUpstreamModel, testTelemetryModelIdentity } from '../../../../../test-helpers.ts';
import type { RequestContext, ResponsesInvocation } from '../../../../llm/interceptors.ts';
import { eventResult } from '../../../../llm/shared/errors/result.ts';
import { eventFrame } from '@floway-dev/protocols/common';
import type { ResponsesPayload } from '@floway-dev/protocols/responses';

const invocation = (payload: ResponsesPayload): ResponsesInvocation => ({
  sourceApi: 'responses',
  targetApi: 'responses',
  model: payload.model,
  upstream: 'test-upstream',
  payload,
  provider: stubProvider(),
  upstreamModel: stubUpstreamModel(),
  enabledFlags: new Set<string>(),
  headers: {},
});

const stubRequest: RequestContext = {
  requestStartedAt: 0,
  runtimeLocation: 'test',
  clientStream: false,
};

test('withConnectionMismatchRetried does not retry unrelated upstream errors', async () => {
  initRepo(new InMemoryRepo());

  const originalId = btoa('0123456789abcdefghij');
  const payload = {
    model: 'gpt-test',
    input: [
      {
        type: 'message',
        id: originalId,
        role: 'user',
        content: 'Hi',
      },
    ] as unknown as ResponsesPayload['input'],
    instructions: null,
    temperature: 1,
    top_p: null,
    max_output_tokens: 32,
    tools: null,
    tool_choice: 'auto',
    metadata: null,
    stream: false,
    store: false,
    parallel_tool_calls: true,
  } satisfies ResponsesPayload;

  let attempts = 0;

  const result = await withConnectionMismatchRetried(invocation(payload), stubRequest, () => {
    attempts += 1;
    return Promise.resolve({
      type: 'upstream-error' as const,
      status: 400,
      headers: new Headers(),
      body: new TextEncoder().encode(JSON.stringify({ error: { message: 'different upstream problem' } })),
    });
  });

  assertEquals(attempts, 1);
  assertEquals((payload.input as unknown as Array<Record<string, unknown>>)[0].id, originalId);
  assertEquals(result.type, 'upstream-error');
});

test('withConnectionMismatchRetried rewrites already-spotted ids before the first attempt', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);

  const originalId = btoa('abcdefghij0123456789');
  await repo.cache.set(`spotted_invalid_id:${originalId}`, '1', 3600_000);

  const payload = {
    model: 'gpt-test',
    input: [
      {
        type: 'message',
        id: originalId,
        role: 'user',
        content: 'Hi',
      },
    ] as unknown as ResponsesPayload['input'],
    instructions: null,
    temperature: 1,
    top_p: null,
    max_output_tokens: 32,
    tools: null,
    tool_choice: 'auto',
    metadata: null,
    stream: false,
    store: false,
    parallel_tool_calls: true,
  } satisfies ResponsesPayload;

  let attempts = 0;
  let seenId = '';

  const result = await withConnectionMismatchRetried(invocation(payload), stubRequest, () => {
    attempts += 1;
    seenId = (payload.input as unknown as Array<Record<string, unknown>>)[0].id as string;

    return Promise.resolve(
      eventResult(
        (async function* () {
          yield eventFrame({
            type: 'response.completed',
            response: {
              id: 'resp_ok',
              object: 'response',
              model: 'gpt-test',
              status: 'completed',
              output_text: 'ok',
              output: [],
              usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
            },
          });
        })(),
        testTelemetryModelIdentity,
      ),
    );
  });

  assertEquals(attempts, 1);
  assertStringIncludes(seenId, 'msg_');
  assertEquals(result.type, 'events');
});
