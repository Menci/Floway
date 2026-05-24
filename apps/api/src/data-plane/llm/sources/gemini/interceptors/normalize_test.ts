import { test } from 'vitest';

import { stripSafetySettings } from './strip-safety-settings.ts';
import { stripUnsupportedPartFieldsFromPayload } from './strip-unsupported-part-fields.ts';
import { stripUnsupportedToolsFromPayload } from './strip-unsupported-tools.ts';
import { assertEquals } from '../../../../../test-assert.ts';
import type { GeminiInvocation, RequestContext } from '../../../interceptors.ts';
import type { GeminiGenerateContentRequest } from '@floway-dev/protocols/gemini';

const testTelemetryModelIdentity = {
  model: 'test-model',
  upstream: 'test-upstream',
  modelKey: 'test-model-key',
  cost: null,
};

const invocation = (payload: GeminiGenerateContentRequest): GeminiInvocation => ({
  sourceApi: 'gemini',
  targetApi: 'chat-completions',
  model: 'gemini-test',
  upstream: 'test-upstream',
  upstreamModel: {} as never,
  provider: {} as never,
  enabledFlags: new Set(),
  payload,
});

const stubRequest: RequestContext = {
  requestStartedAt: 0,
  runtimeLocation: 'test',
  clientStream: false,
};

const runStripSafetySettings = async (payload: GeminiGenerateContentRequest): Promise<void> => {
  await stripSafetySettings(invocation(payload), stubRequest, () =>
    Promise.resolve({
      type: 'events' as const,
      events: (async function* () {})(),
      modelIdentity: testTelemetryModelIdentity,
    }));
};

const normalize = async (payload: GeminiGenerateContentRequest): Promise<void> => {
  stripUnsupportedPartFieldsFromPayload(payload);
  stripUnsupportedToolsFromPayload(payload);
  await runStripSafetySettings(payload);
};

test('gemini source interceptors strip unsupported part fields and preserve supported fields', async () => {
  const payload: GeminiGenerateContentRequest = {
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
            functionResponse: {
              id: 'call-1',
              name: 'lookup',
              response: { ok: true },
            },
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
  };

  await normalize(payload);

  assertEquals(payload, {
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
            functionResponse: {
              id: 'call-1',
              name: 'lookup',
              response: { ok: true },
            },
          },
        ],
      },
    ],
    systemInstruction: {
      parts: [{ text: 'system' }],
    },
  });
});

test('gemini source interceptors remove parts that only contain unsupported file or code fields', async () => {
  const payload: GeminiGenerateContentRequest = {
    contents: [
      {
        role: 'user',
        parts: [
          {
            fileData: { mimeType: 'text/plain', fileUri: 'gs://bucket/file.txt' },
          },
          {
            text: 'keep me',
          },
          {
            executableCode: { language: 'python', code: 'print(1)' },
            codeExecutionResult: { outcome: 'OUTCOME_OK', output: '1' },
          },
        ],
      },
    ],
    systemInstruction: {
      parts: [
        {
          fileData: { mimeType: 'text/plain', fileUri: 'gs://bucket/system.txt' },
        },
        {
          text: 'system',
        },
      ],
    },
  };

  await normalize(payload);

  assertEquals(payload, {
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

test('gemini source interceptors strip unsupported tool capabilities and remove empty tool groups', async () => {
  const payload: GeminiGenerateContentRequest = {
    tools: [
      {
        functionDeclarations: [
          {
            name: 'lookup',
            description: 'Look up a value',
            parameters: {
              type: 'object',
              properties: { query: { type: 'string' } },
            },
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
      {
        googleSearch: {},
      },
      {
        codeExecution: {},
      },
    ],
  };

  await normalize(payload);

  assertEquals(payload, {
    tools: [
      {
        functionDeclarations: [
          {
            name: 'lookup',
            description: 'Look up a value',
            parameters: {
              type: 'object',
              properties: { query: { type: 'string' } },
            },
          },
        ],
      },
    ],
  });
});

test('gemini source interceptors remove safety settings without inventing missing defaults', async () => {
  const payload: GeminiGenerateContentRequest = {
    cachedContent: 'cachedContents/example',
    safetySettings: [
      {
        category: 'HARM_CATEGORY_DANGEROUS_CONTENT',
        threshold: 'BLOCK_ONLY_HIGH',
      },
    ],
  };

  await normalize(payload);

  assertEquals(payload, {
    cachedContent: 'cachedContents/example',
  });
});
