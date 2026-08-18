import { test } from 'vitest';

import { stripUnsupportedTools } from '../../../../../src/data-plane/chat/gemini-generate-content/interceptors/strip-unsupported-tools.ts';
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
