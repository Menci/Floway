import { test } from 'vitest';

import { stripSafetySettings } from '../../../../../src/data-plane/chat/gemini-generate-content/interceptors/strip-safety-settings.ts';
import { mockChatGatewayCtx } from '../../../../test-utils/gateway-ctx.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiGenerateContentPayload, GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';
import { type ExecuteResult, eventResult, type GeminiGenerateContentInvocation } from '@floway-dev/provider';
import { assertEquals, stubModelCandidate, testTelemetryModelIdentity } from '@floway-dev/test-utils';

const stubCtx = mockChatGatewayCtx();

const okEvents = (): Promise<ExecuteResult<ProtocolFrame<GeminiGenerateContentStreamEvent>>> =>
  Promise.resolve(eventResult((async function* (): AsyncGenerator<ProtocolFrame<GeminiGenerateContentStreamEvent>> {})(), testTelemetryModelIdentity));

const invocation = (payload: GeminiGenerateContentPayload): GeminiGenerateContentInvocation => ({
  payload,
  candidate: stubModelCandidate(),
  targetApi: 'anthropicMessages',
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
