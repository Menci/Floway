import { test } from 'vitest';

import { stripUnsupportedTools } from './strip-unsupported-tools.ts';
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

test('strips non-functionDeclarations capabilities and drops groups that become empty', async () => {
  const input = invocation({
    tools: [
      {
        functionDeclarations: [
          {
            name: 'lookup',
            description: 'Look up a value',
            parameters: { type: 'object', properties: { query: { type: 'string' } } },
          },
        ],
        googleSearch: {},
        googleSearchRetrieval: {},
        codeExecution: {},
        computerUse: {},
        urlContext: {},
        fileSearch: {},
        mcpServers: [{ name: 'server' }],
        googleMaps: {},
      },
      { googleSearch: {} },
      { codeExecution: {} },
    ],
  });

  await stripUnsupportedTools(input, stubCtx, okEvents);

  assertEquals(input.payload, {
    tools: [
      {
        functionDeclarations: [
          {
            name: 'lookup',
            description: 'Look up a value',
            parameters: { type: 'object', properties: { query: { type: 'string' } } },
          },
        ],
      },
    ],
  });
});

test('removes the tools field entirely when every group becomes empty', async () => {
  const input = invocation({
    tools: [
      { googleSearch: {} },
      { codeExecution: {} },
    ],
  });

  await stripUnsupportedTools(input, stubCtx, okEvents);

  assertEquals(input.payload, {});
});

test('is a no-op when tools is absent', async () => {
  const input = invocation({
    contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
  });

  await stripUnsupportedTools(input, stubCtx, okEvents);

  assertEquals(input.payload, {
    contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
  });
});
