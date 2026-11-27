import { expect, test, vi } from 'vitest';

import { openaiChatCompletionsAttempt } from '../../../../src/data-plane/chat/openai-chat-completions/attempt.ts';
import { initRepo } from '../../../../src/repo/index.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { mockChatGatewayCtx } from '../../../test-utils/gateway-ctx.ts';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type {
  GeminiGenerateContentPayload,
  GeminiGenerateContentStreamEvent,
} from '@floway-dev/protocols/gemini-generate-content';
import {
  collectOpenAIChatCompletionsProtocolEventsToResult,
  type OpenAIChatCompletionsPayload,
} from '@floway-dev/protocols/openai-chat-completions';
import { stubUpstream, stubUpstreamModel } from '@floway-dev/test-utils';
import {
  decodeResponseBody,
  directFetcher,
  type ModelCandidate,
  type UpstreamCallOptions,
  type UpstreamStreamResult,
} from '@floway-dev/upstream';

const makeProtocolFrames = async function* <TEvent>(events: readonly TEvent[]): AsyncGenerator<ProtocolFrame<TEvent>> {
  for (const event of events) yield eventFrame(event);
};

const makeCandidate = (
  callGeminiGenerateContent: (
    model: unknown,
    body: GeminiGenerateContentPayload,
    signal?: AbortSignal,
    opts?: UpstreamCallOptions,
  ) => Promise<UpstreamStreamResult<GeminiGenerateContentStreamEvent>>,
): ModelCandidate => ({
  upstream: {
    upstreamId: 'up_gemini_chat',
    kind: 'custom',
    name: 'Gemini Upstream',
    inboundHeaderAllowlist: [],
    instance: stubUpstream({ callGeminiGenerateContent }),
  },
  model: stubUpstreamModel({
    id: 'gemini-2.5-pro',
    upstreamModelId: 'gemini-2.5-pro',
    endpoints: { geminiGenerateContent: {} },
  }),
  fetcher: directFetcher,
});

test('routes OpenAI Chat Completions to Gemini, strips model, and preserves relay HTTP error semantics', async () => {
  initRepo(new InMemoryRepo());

  let capturedBody: GeminiGenerateContentPayload | undefined;
  const callGeminiGenerateContent = vi.fn(async (_model, body: GeminiGenerateContentPayload): Promise<UpstreamStreamResult<GeminiGenerateContentStreamEvent>> => {
    capturedBody = body;
    return {
      ok: true,
      modelKey: 'gemini-2.5-pro',
      http: { status: 200, headers: new Headers() },
      events: makeProtocolFrames<GeminiGenerateContentStreamEvent>([
        {
          responseId: 'gem_chat_1',
          modelVersion: 'gemini-2.5-pro',
          candidates: [{
            index: 0,
            content: {
              role: 'model',
              parts: [
                { thought: true, text: 'Visible reasoning.' },
                { text: 'Hello from Gemini!' },
              ],
            },
            finishReason: 'STOP',
          }],
          usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 4, thoughtsTokenCount: 3, totalTokenCount: 15 },
        },
      ]),
    };
  });

  const payload: OpenAIChatCompletionsPayload = {
    model: 'gemini-2.5-pro',
    reasoning_effort: 'high',
    messages: [
      { role: 'system', content: 'Be concise.' },
      { role: 'user', content: 'Say hello' },
    ],
  };

  const result = await openaiChatCompletionsAttempt.generate({
    payload,
    ctx: mockChatGatewayCtx({ apiKeyId: 'key_chat_gem', wantsStream: true }),
    candidate: makeCandidate(callGeminiGenerateContent),
    headers: new Headers(),
  });

  expect(capturedBody).toBeDefined();
  expect('model' in capturedBody!).toBe(false);
  expect(capturedBody).toEqual({
    systemInstruction: { parts: [{ text: 'Be concise.' }] },
    contents: [{ role: 'user', parts: [{ text: 'Say hello' }] }],
    generationConfig: {
      thinkingConfig: { thinkingLevel: 'HIGH', includeThoughts: true },
    },
  });

  expect(result.type).toBe('events');
  if (result.type !== 'events') throw new Error('Expected streaming events result');
  const assembled = await collectOpenAIChatCompletionsProtocolEventsToResult(result.events);
  expect(assembled.choices[0].message.content).toBe('Hello from Gemini!');
  expect(assembled.choices[0].message.reasoning_text).toBe('Visible reasoning.');
  expect(assembled.choices[0].finish_reason).toBe('stop');

  // Relay OpenAI-style error body on Gemini upstream keeps its code and HTTP status intact.
  const relayErr = await openaiChatCompletionsAttempt.generate({
    payload,
    ctx: mockChatGatewayCtx({ apiKeyId: 'key_chat_gem_err', wantsStream: true }),
    candidate: makeCandidate(async () => ({
      ok: false,
      modelKey: 'gemini-2.5-pro',
      http: new Response(JSON.stringify({ error: { code: 'context_length_exceeded', message: 'too long' } }), {
        status: 422,
        headers: new Headers({ 'content-type': 'application/json' }),
      }),
    })),
    headers: new Headers(),
  });
  expect(relayErr.type).toBe('api-error');
  if (relayErr.type !== 'api-error') throw new Error('Expected api-error');
  expect(relayErr.http.status).toBe(422);
  expect(JSON.parse(decodeResponseBody(relayErr.body))).toEqual({
    error: { code: 'context_length_exceeded', message: 'too long' },
  });
});
