import { test } from 'vitest';

import { stripSafetySettings } from './strip-safety-settings.ts';
import { createNonResponsesSourceStore } from '../../responses/items/store.ts';
import type { ChatGatewayCtx } from '../../shared/gateway-ctx.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiPayload, GeminiStreamEvent } from '@floway-dev/protocols/gemini';
import { type ExecuteResult, eventResult, type GeminiInvocation } from '@floway-dev/provider';
import { assertEquals, stubModelCandidate, testTelemetryModelIdentity } from '@floway-dev/test-utils';

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

const okEvents = (): Promise<ExecuteResult<ProtocolFrame<GeminiStreamEvent>>> =>
  Promise.resolve(eventResult((async function* (): AsyncGenerator<ProtocolFrame<GeminiStreamEvent>> {})(), testTelemetryModelIdentity));

const invocation = (payload: GeminiPayload): GeminiInvocation => ({
  payload,
  candidate: stubModelCandidate(),
  targetApi: 'messages',
  headers: new Headers(),
});

test('removes safetySettings without inventing missing defaults and preserves siblings', async () => {
  const input = invocation({
    cachedContent: 'cachedContents/example',
    safetySettings: [
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
    ],
  });

  await stripSafetySettings(input, stubCtx, okEvents);

  assertEquals(input.payload, { cachedContent: 'cachedContents/example' });
});

test('is a no-op when safetySettings is absent', async () => {
  const input = invocation({
    contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
  });

  await stripSafetySettings(input, stubCtx, okEvents);

  assertEquals(input.payload, { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] });
});
