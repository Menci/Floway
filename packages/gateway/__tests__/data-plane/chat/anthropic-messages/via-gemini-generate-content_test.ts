import { expect, test, vi } from 'vitest';

import { anthropicMessagesAttempt } from '../../../../src/data-plane/chat/anthropic-messages/attempt.ts';
import { initRepo } from '../../../../src/repo/index.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { mockChatGatewayCtx } from '../../../test-utils/gateway-ctx.ts';
import {
  collectAnthropicMessagesProtocolEventsToResult,
  type AnthropicMessagesPayload,
} from '@floway-dev/protocols/anthropic-messages';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type {
  GeminiGenerateContentPayload,
  GeminiGenerateContentStreamEvent,
} from '@floway-dev/protocols/gemini-generate-content';
import { stubUpstream, stubUpstreamModel } from '@floway-dev/test-utils';
import {
  decodeResponseBody,
  directFetcher,
  type FlagId,
  type ModelCandidate,
  type UpstreamCallOptions,
  type UpstreamCallResult,
  type UpstreamStreamResult,
} from '@floway-dev/upstream';

const makeProtocolFrames = async function* <TEvent>(events: readonly TEvent[]): AsyncGenerator<ProtocolFrame<TEvent>> {
  for (const event of events) yield eventFrame(event);
};

const makeCandidate = (overrides: {
  enabledFlags?: ReadonlySet<FlagId>;
  inboundHeaderAllowlist?: readonly string[];
  callGeminiGenerateContent?: (
    model: unknown,
    body: GeminiGenerateContentPayload,
    signal?: AbortSignal,
    opts?: UpstreamCallOptions,
  ) => Promise<UpstreamStreamResult<GeminiGenerateContentStreamEvent>>;
  callGeminiGenerateContentCountTokens?: (
    model: unknown,
    body: GeminiGenerateContentPayload,
    signal?: AbortSignal,
    opts?: UpstreamCallOptions,
  ) => Promise<UpstreamCallResult>;
}): ModelCandidate => ({
  upstream: {
    upstreamId: 'up_gemini_msg',
    kind: 'custom',
    name: 'Gemini Upstream',
    inboundHeaderAllowlist: [...(overrides.inboundHeaderAllowlist ?? [])],
    instance: stubUpstream({
      callGeminiGenerateContent: overrides.callGeminiGenerateContent,
      callGeminiGenerateContentCountTokens: overrides.callGeminiGenerateContentCountTokens,
    }),
  },
  model: stubUpstreamModel({
    id: 'gemini-2.5-pro',
    upstreamModelId: 'gemini-2.5-pro',
    endpoints: { geminiGenerateContent: {} },
    ...(overrides.enabledFlags === undefined ? {} : { enabledFlags: new Set(overrides.enabledFlags) }),
  }),
  fetcher: directFetcher,
});

test('routes Anthropic Messages generate to Gemini, strips model, and translates upstream HTTP errors without normalization corruption', async () => {
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
          responseId: 'gem_msg_gw',
          modelVersion: 'gemini-2.5-pro',
          candidates: [{
            index: 0,
            content: {
              role: 'model',
              parts: [
                { thought: true, text: 'Messages reasoning.' },
                { text: 'Messages answer from Gemini!' },
              ],
            },
            finishReason: 'STOP',
          }],
          usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 5, thoughtsTokenCount: 3, totalTokenCount: 15 },
        },
      ]),
    };
  });

  const payload: AnthropicMessagesPayload = {
    model: 'gemini-2.5-pro',
    max_tokens: 1024,
    system: 'Be helpful.',
    thinking: { type: 'enabled', budget_tokens: 512 },
    messages: [{ role: 'user', content: 'Hello from Claude client' }],
  };

  const result = await anthropicMessagesAttempt.generate({
    payload,
    ctx: mockChatGatewayCtx({ apiKeyId: 'key_msg_gem', wantsStream: true }),
    candidate: makeCandidate({ callGeminiGenerateContent }),
    headers: new Headers(),
    anthropicBeta: [],
  });

  expect(capturedBody).toBeDefined();
  expect('model' in capturedBody!).toBe(false);
  expect(capturedBody).toMatchObject({
    systemInstruction: { parts: [{ text: 'Be helpful.' }] },
    contents: [{ role: 'user', parts: [{ text: 'Hello from Claude client' }] }],
    generationConfig: {
      maxOutputTokens: 1024,
      thinkingConfig: { thinkingBudget: 512, includeThoughts: true },
    },
  });

  expect(result.type).toBe('events');
  if (result.type !== 'events') throw new Error('Expected streaming events result');
  const assembled = await collectAnthropicMessagesProtocolEventsToResult(result.events);
  expect(assembled.stop_reason).toBe('end_turn');
  expect(assembled.content).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: 'thinking', thinking: 'Messages reasoning.' }),
    expect.objectContaining({ type: 'text', text: 'Messages answer from Gemini!' }),
  ]));

  // Single-element `:streamGenerateContent` error array must reach `trip.error` untouched by Gemini-native normalization.
  const arrayError = await anthropicMessagesAttempt.generate({
    payload,
    ctx: mockChatGatewayCtx({ apiKeyId: 'key_msg_gem_err', wantsStream: true }),
    candidate: makeCandidate({
      callGeminiGenerateContent: async () => ({
        ok: false,
        modelKey: 'gemini-2.5-pro',
        http: new Response(JSON.stringify([{
          error: {
            code: 429,
            message: 'Quota exceeded',
            status: 'RESOURCE_EXHAUSTED',
            details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '5s' }],
          },
        }]), {
          status: 429,
          headers: new Headers({ 'content-type': 'application/json', 'retry-after': '5' }),
        }),
      }),
    }),
    headers: new Headers(),
    anthropicBeta: [],
  });
  expect(arrayError.type).toBe('api-error');
  if (arrayError.type !== 'api-error') throw new Error('Expected api-error');
  expect(arrayError.http.status).toBe(429);
  expect(arrayError.http.headers.get('retry-after')).toBe('5');
  expect(JSON.parse(decodeResponseBody(arrayError.body))).toEqual({
    type: 'error',
    error: {
      type: 'rate_limit_error',
      message: 'Quota exceeded',
      provider_specific_fields: {
        code: 429,
        status: 'RESOURCE_EXHAUSTED',
        details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '5s' }],
      },
    },
  });

  // Unrecognized non-JSON HTML error with non-standard status must pass through verbatim.
  const htmlError = await anthropicMessagesAttempt.generate({
    payload,
    ctx: mockChatGatewayCtx({ apiKeyId: 'key_msg_gem_html', wantsStream: true }),
    candidate: makeCandidate({
      callGeminiGenerateContent: async () => ({
        ok: false,
        modelKey: 'gemini-2.5-pro',
        http: new Response('<html>504 Gateway Timeout</html>', {
          status: 504,
          headers: new Headers({ 'content-type': 'text/html' }),
        }),
      }),
    }),
    headers: new Headers(),
    anthropicBeta: [],
  });
  expect(htmlError.type).toBe('api-error');
  if (htmlError.type !== 'api-error') throw new Error('Expected api-error');
  expect(htmlError.http.status).toBe(504);
  expect(htmlError.http.headers.get('content-type')).toBe('text/html');
  expect(decodeResponseBody(htmlError.body)).toBe('<html>504 Gateway Timeout</html>');
});

test('translates Anthropic Messages count_tokens to Gemini countTokens, preserves request interceptors, and reshapes responses and errors', async () => {
  initRepo(new InMemoryRepo());
  let capturedBody: GeminiGenerateContentPayload | undefined;
  let capturedHeaders: Headers | undefined;
  const callGeminiGenerateContentCountTokens = vi.fn(async (_model, body: GeminiGenerateContentPayload, _signal, opts?: UpstreamCallOptions): Promise<UpstreamCallResult> => {
    capturedBody = body;
    capturedHeaders = opts?.headers;
    return {
      http: new Response(JSON.stringify({ totalTokens: 73 }), {
        status: 200,
        headers: new Headers({ 'content-type': 'application/json', 'x-trace-id': 'gem-count-1' }),
      }),
      modelKey: 'gemini-2.5-pro',
    };
  });

  const ctx = mockChatGatewayCtx({ apiKeyId: 'key_msg_gem_count', wantsStream: false });
  const ok = await anthropicMessagesAttempt.countTokens({
    payload: {
      model: 'gemini-2.5-pro',
      system: 'x-anthropic-billing-header: token\ncch=deadbeef1234;\nCount rules.',
      messages: [{ role: 'user', content: 'How many tokens?' }],
    } as AnthropicMessagesPayload,
    ctx,
    candidate: makeCandidate({
      enabledFlags: new Set<FlagId>(['strip-billing-attribution']),
      inboundHeaderAllowlist: ['anthropic-beta', 'x-client-tag'],
      callGeminiGenerateContentCountTokens,
    }),
    headers: new Headers({ 'anthropic-beta': 'claude-code-20250219', 'x-client-tag': 'keep' }),
    anthropicBeta: ['claude-code-20250219'],
  });

  expect(ok.type).toBe('plain');
  expect(ok.http.status).toBe(200);
  expect(ok.http.headers.get('x-trace-id')).toBe('gem-count-1');
  expect(JSON.parse(decodeResponseBody(ok.body))).toEqual({ input_tokens: 73 });
  expect(capturedHeaders?.has('anthropic-beta')).toBe(false);
  expect(capturedHeaders?.get('x-client-tag')).toBe('keep');
  expect(capturedBody).toEqual({
    systemInstruction: { parts: [{ text: 'Count rules.' }] },
    contents: [{ role: 'user', parts: [{ text: 'How many tokens?' }] }],
  });

  const rateLimited = await anthropicMessagesAttempt.countTokens({
    payload: { model: 'gemini-2.5-pro', messages: [{ role: 'user', content: 'hi' }] } as AnthropicMessagesPayload,
    ctx,
    candidate: makeCandidate({
      callGeminiGenerateContentCountTokens: async () => ({
        http: new Response(JSON.stringify({ error: { code: 429, message: 'Quota exceeded', status: 'RESOURCE_EXHAUSTED' } }), {
          status: 429,
          headers: new Headers({ 'content-type': 'application/json', 'retry-after': '12' }),
        }),
        modelKey: 'gemini-2.5-pro',
      }),
    }),
    headers: new Headers(),
    anthropicBeta: [],
  });
  expect(rateLimited.type).toBe('plain');
  expect(rateLimited.http.status).toBe(429);
  expect(rateLimited.http.headers.get('retry-after')).toBe('12');
  expect(JSON.parse(decodeResponseBody(rateLimited.body))).toMatchObject({
    type: 'error',
    error: {
      type: 'rate_limit_error',
      message: 'Quota exceeded',
      provider_specific_fields: { code: 429, status: 'RESOURCE_EXHAUSTED' },
    },
  });

  // Unrecognized plain-text error uses Anthropic status mapping and fallback message when empty.
  const plainTextErr = await anthropicMessagesAttempt.countTokens({
    payload: { model: 'gemini-2.5-pro', messages: [{ role: 'user', content: 'hi' }] } as AnthropicMessagesPayload,
    ctx,
    candidate: makeCandidate({
      callGeminiGenerateContentCountTokens: async () => ({
        http: new Response('', { status: 529, headers: new Headers({ 'content-type': 'text/plain' }) }),
        modelKey: 'gemini-2.5-pro',
      }),
    }),
    headers: new Headers(),
    anthropicBeta: [],
  });
  expect(plainTextErr.type).toBe('plain');
  expect(plainTextErr.http.status).toBe(529);
  expect(JSON.parse(decodeResponseBody(plainTextErr.body))).toMatchObject({
    type: 'error',
    error: { type: 'overloaded_error', message: 'Upstream token counting request failed.' },
  });

  const malformed = await anthropicMessagesAttempt.countTokens({
    payload: { model: 'gemini-2.5-pro', messages: [{ role: 'user', content: 'hi' }] } as AnthropicMessagesPayload,
    ctx,
    candidate: makeCandidate({
      callGeminiGenerateContentCountTokens: async () => ({
        http: new Response('not-json', { status: 200, headers: new Headers({ 'content-type': 'application/json' }) }),
        modelKey: 'gemini-2.5-pro',
      }),
    }),
    headers: new Headers(),
    anthropicBeta: [],
  });
  expect(malformed.type).toBe('plain');
  expect(malformed.http.status).toBe(502);
  expect(JSON.parse(decodeResponseBody(malformed.body))).toMatchObject({
    type: 'error',
    error: { type: 'api_error' },
  });

  const empty204 = await anthropicMessagesAttempt.countTokens({
    payload: { model: 'gemini-2.5-pro', messages: [{ role: 'user', content: 'hi' }] } as AnthropicMessagesPayload,
    ctx,
    candidate: makeCandidate({
      callGeminiGenerateContentCountTokens: async () => ({
        http: new Response(null, { status: 204 }),
        modelKey: 'gemini-2.5-pro',
      }),
    }),
    headers: new Headers(),
    anthropicBeta: [],
  });
  expect(empty204.type).toBe('plain');
  expect(empty204.http.status).toBe(204);
  expect(empty204.body).toBeNull();

  const inputError = await anthropicMessagesAttempt.countTokens({
    payload: {
      model: 'gemini-2.5-pro',
      messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'file', file_id: 'file_123' } }] }],
    } as AnthropicMessagesPayload,
    ctx,
    candidate: makeCandidate({}),
    headers: new Headers(),
    anthropicBeta: [],
  });
  expect(inputError.type).toBe('api-error');
  expect(inputError.http.status).toBe(400);
  expect(JSON.parse(decodeResponseBody(inputError.body))).toMatchObject({
    type: 'error',
    error: { type: 'invalid_request_error' },
  });
});
