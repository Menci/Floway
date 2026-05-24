import { test } from 'vitest';

import { collectGeminiProtocolEventsToResponse } from './to-response.ts';
import { assertEquals, assertRejects } from '../../../../../test-assert.ts';
import { eventFrame } from '@floway-dev/protocols/common';
import type { GeminiGenerateContentResponse, GeminiStreamEvent } from '@floway-dev/protocols/gemini';

test('collectGeminiProtocolEventsToResponse assembles candidate parts and final metadata', async () => {
  async function* events() {
    const payloads: GeminiStreamEvent[] = [
      {
        candidates: [
          {
            index: 0,
            content: {
              role: 'model',
              parts: [{ text: 'He' }, { text: 'l' }],
            },
          },
        ],
        modelVersion: 'gemini-test-preview',
        responseId: 'response-early',
      },
      {
        candidates: [
          {
            index: 0,
            content: {
              role: 'model',
              parts: [{ text: 'lo' }, { text: 'thinking', thought: true }],
            },
          },
          {
            index: 1,
            content: {
              role: 'model',
              parts: [{ functionCall: { id: 'call-1', name: 'lookup', args: {} } }],
            },
          },
        ],
        usageMetadata: { promptTokenCount: 2, totalTokenCount: 4 },
      },
      {
        candidates: [
          {
            index: 0,
            content: {
              role: 'model',
              parts: [{ text: ' signed', thoughtSignature: 'sig-1' }, { text: ' tail' }],
            },
            finishReason: 'STOP',
          },
        ],
        modelVersion: 'gemini-test',
        responseId: 'response-final',
        usageMetadata: {
          promptTokenCount: 2,
          candidatesTokenCount: 6,
          totalTokenCount: 8,
          thoughtsTokenCount: 1,
        },
      },
    ];

    for (const payload of payloads) yield eventFrame(payload);
  }

  const expected: GeminiGenerateContentResponse = {
    candidates: [
      {
        index: 0,
        content: {
          role: 'model',
          parts: [{ text: 'Hello' }, { text: 'thinking', thought: true }, { text: ' signed', thoughtSignature: 'sig-1' }, { text: ' tail' }],
        },
        finishReason: 'STOP',
      },
      {
        index: 1,
        content: {
          role: 'model',
          parts: [{ functionCall: { id: 'call-1', name: 'lookup', args: {} } }],
        },
      },
    ],
    modelVersion: 'gemini-test',
    responseId: 'response-final',
    usageMetadata: {
      promptTokenCount: 2,
      candidatesTokenCount: 6,
      totalTokenCount: 8,
      thoughtsTokenCount: 1,
    },
  };

  assertEquals(await collectGeminiProtocolEventsToResponse(events()), expected);
});

test('collectGeminiProtocolEventsToResponse throws Gemini error events', async () => {
  const errorEvent = {
    error: {
      code: 429,
      message: 'quota exceeded',
      status: 'RESOURCE_EXHAUSTED',
    },
  } satisfies GeminiStreamEvent;

  const error = await assertRejects(
    async () => {
      await collectGeminiProtocolEventsToResponse(
        (async function* () {
          yield eventFrame(errorEvent);
        })(),
      );
    },
    Error,
    'RESOURCE_EXHAUSTED: quota exceeded',
  );

  assertEquals(error.cause, errorEvent);
});
