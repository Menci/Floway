import { test } from 'vitest';

import { stripUnsupportedPartFields } from './strip-unsupported-part-fields.ts';
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

test('strips fileData, executableCode, and codeExecutionResult while preserving supported part fields', async () => {
  const input = invocation({
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: 'hello',
            thought: true,
            thoughtSignature: 'thought-signature',
            inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' },
            functionCall: { id: 'call-1', name: 'lookup', args: { query: 'docs' } },
            functionResponse: { id: 'call-1', name: 'lookup', response: { ok: true } },
            fileData: { mimeType: 'text/plain', fileUri: 'gs://bucket/file.txt' },
            executableCode: { language: 'python', code: 'print(1)' },
            codeExecutionResult: { outcome: 'OUTCOME_OK', output: '1' },
          },
        ],
      },
    ],
    systemInstruction: {
      parts: [
        {
          text: 'system',
          fileData: { mimeType: 'text/plain', fileUri: 'gs://bucket/system.txt' },
        },
      ],
    },
  });

  await stripUnsupportedPartFields(input, stubCtx, okEvents);

  assertEquals(input.payload, {
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: 'hello',
            thought: true,
            thoughtSignature: 'thought-signature',
            inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' },
            functionCall: { id: 'call-1', name: 'lookup', args: { query: 'docs' } },
            functionResponse: { id: 'call-1', name: 'lookup', response: { ok: true } },
          },
        ],
      },
    ],
    systemInstruction: {
      parts: [{ text: 'system' }],
    },
  });
});

test('removes parts that only contain unsupported file or code fields', async () => {
  const input = invocation({
    contents: [
      {
        role: 'user',
        parts: [
          { fileData: { mimeType: 'text/plain', fileUri: 'gs://bucket/file.txt' } },
          { text: 'keep me' },
          {
            executableCode: { language: 'python', code: 'print(1)' },
            codeExecutionResult: { outcome: 'OUTCOME_OK', output: '1' },
          },
        ],
      },
    ],
    systemInstruction: {
      parts: [
        { fileData: { mimeType: 'text/plain', fileUri: 'gs://bucket/system.txt' } },
        { text: 'system' },
      ],
    },
  });

  await stripUnsupportedPartFields(input, stubCtx, okEvents);

  assertEquals(input.payload, {
    contents: [
      {
        role: 'user',
        parts: [{ text: 'keep me' }],
      },
    ],
    systemInstruction: {
      parts: [{ text: 'system' }],
    },
  });
});

test('is a no-op when no unsupported part fields are present', async () => {
  const input = invocation({
    contents: [
      { role: 'user', parts: [{ text: 'hello' }] },
    ],
  });

  await stripUnsupportedPartFields(input, stubCtx, okEvents);

  assertEquals(input.payload, {
    contents: [
      { role: 'user', parts: [{ text: 'hello' }] },
    ],
  });
});
