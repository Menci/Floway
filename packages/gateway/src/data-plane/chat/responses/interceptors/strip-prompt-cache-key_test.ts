import { test } from 'vitest';

import { withPromptCacheKeyStripped } from './strip-prompt-cache-key.ts';
import type { ResponsesInvocation } from './types.ts';
import type { ChatGatewayCtx } from '../../shared/gateway-ctx.ts';
import { createNonResponsesSourceStore } from '../items/store.ts';
import { doneFrame } from '@floway-dev/protocols/common';
import { eventResult, type FlagId } from '@floway-dev/provider';
import { assertEquals, stubModelCandidate, testTelemetryModelIdentity } from '@floway-dev/test-utils';
import type { CanonicalResponsesPayload } from '@floway-dev/translate/via-responses/responses-items';

const stubCtx: ChatGatewayCtx = {
  apiKeyId: 'test-key',
  upstreamIds: null,
  wantsStream: false,
  runtimeLocation: 'TEST',
  currentColo: 'TEST',
  dump: null,
  responseHeaders: new Headers(),
  backgroundScheduler: () => {},
  requestStartedAt: 0,
  store: createNonResponsesSourceStore('test-key'),
};

const okEvents = () =>
  Promise.resolve(
    eventResult(
      (async function* () {
        yield doneFrame();
      })(),
      testTelemetryModelIdentity,
    ),
  );

const invocation = (
  payload: CanonicalResponsesPayload,
  enabledFlags: ReadonlySet<FlagId> = new Set(['strip-prompt-cache-key']),
): ResponsesInvocation => ({
  payload,
  candidate: stubModelCandidate({ enabledFlags }),
  targetApi: 'responses',
  headers: new Headers(),
  action: 'generate',
});

test('drops top-level prompt_cache_key when the flag is on', async () => {
  const input = invocation({
    model: 'm',
    input: [{ type: 'message', role: 'user', content: 'hi' }],
    prompt_cache_key: 'thread-42',
  });

  await withPromptCacheKeyStripped(input, stubCtx, okEvents);

  assertEquals(Object.hasOwn(input.payload, 'prompt_cache_key'), false);
});

test('leaves the payload untouched when prompt_cache_key is absent', async () => {
  const input = invocation({
    model: 'm',
    input: [{ type: 'message', role: 'user', content: 'hi' }],
  });
  const before = input.payload;

  await withPromptCacheKeyStripped(input, stubCtx, okEvents);

  assertEquals(input.payload, before);
});

test('is a no-op when the flag is not set on the candidate', async () => {
  const input = invocation(
    {
      model: 'm',
      input: [{ type: 'message', role: 'user', content: 'hi' }],
      prompt_cache_key: 'thread-42',
    },
    new Set(),
  );

  await withPromptCacheKeyStripped(input, stubCtx, okEvents);

  assertEquals(input.payload.prompt_cache_key, 'thread-42');
});
