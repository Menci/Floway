import { test } from 'vitest';

import { stripSafetySettings } from './strip-safety-settings.ts';
import { mockChatGatewayCtx } from '../../../../test-helpers/gateway-ctx.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiPayload, GeminiStreamEvent } from '@floway-dev/protocols/gemini';
import { type ExecuteResult, eventResult, type GeminiInvocation } from '@floway-dev/provider';
import { assertEquals, stubModelCandidate, testTelemetryModelIdentity } from '@floway-dev/test-utils';

const stubCtx = mockChatGatewayCtx();

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
