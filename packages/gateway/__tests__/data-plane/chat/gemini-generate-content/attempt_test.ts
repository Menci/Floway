import { test, vi } from 'vitest';

import { geminiGenerateContentAttempt } from '../../../../src/data-plane/chat/gemini-generate-content/attempt.ts';
import { initRepo } from '../../../../src/repo/index.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { mockChatGatewayCtx } from '../../../test-utils/gateway-ctx.ts';
import { parseJSONWithRawNumbers, type ModelEndpoints } from '@floway-dev/protocols/common';
import type { GeminiGenerateContentPayload } from '@floway-dev/protocols/gemini-generate-content';
import { assertEquals, stubUpstream, stubUpstreamModel } from '@floway-dev/test-utils';
import { decodeResponseBody, type AnthropicMessagesUpstreamCallOptions, type ModelCandidate, directFetcher, type UpstreamCallResult, type UpstreamCallOptions } from '@floway-dev/upstream';

const API_KEY_ID = 'key_gemini_attempt_test';

const makeGatewayCtx = () => mockChatGatewayCtx({ apiKeyId: API_KEY_ID, wantsStream: true });

const makePayload = (overrides: Partial<GeminiGenerateContentPayload> = {}): GeminiGenerateContentPayload => ({
  contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
  ...overrides,
});

const installRepo = (): InMemoryRepo => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  return repo;
};

const makeCandidate = (overrides: {
  upstream?: string;
  endpoints?: ModelEndpoints;
  rules?: ModelCandidate['rules'];
  callAnthropicMessagesCountTokens?: (model: unknown, body: unknown, signal?: AbortSignal, opts?: AnthropicMessagesUpstreamCallOptions) => Promise<UpstreamCallResult>;
  callGeminiGenerateContentCountTokens?: (model: unknown, body: unknown, signal?: AbortSignal, opts?: UpstreamCallOptions) => Promise<UpstreamCallResult>;
} = {}): ModelCandidate => {
  const upstream = overrides.upstream ?? 'up_test';
  const instance = stubUpstream({
    callAnthropicMessagesCountTokens: overrides.callAnthropicMessagesCountTokens,
    callGeminiGenerateContentCountTokens: overrides.callGeminiGenerateContentCountTokens,
  });
  return {
    upstream: {
      upstreamId: upstream, kind: 'custom', name: upstream, inboundHeaderAllowlist: [],
      instance,
    },
    model: stubUpstreamModel(overrides.endpoints ? { endpoints: overrides.endpoints } : {}),
    ...(overrides.rules === undefined ? {} : { rules: overrides.rules }),
    fetcher: directFetcher,
  };
};

test('countTokens translates Gemini generateContent to Anthropic Messages count_tokens and reshapes to totalTokens envelope', async () => {
  installRepo();
  let upstreamBody: Record<string, unknown> | undefined;
  let callOptions: AnthropicMessagesUpstreamCallOptions | undefined;
  const callAnthropicMessagesCountTokens = vi.fn(async (_model, body, _signal, opts): Promise<UpstreamCallResult> => {
    upstreamBody = body as Record<string, unknown>;
    callOptions = opts;
    return {
      http: new Response(JSON.stringify({ input_tokens: 42 }), {
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
      }),
      modelKey: 'k',
    };
  });
  const result = await geminiGenerateContentAttempt.countTokens({
    payload: makePayload({ systemInstruction: { parts: [{ text: 'system' }] } }),
    ctx: makeGatewayCtx(),
    candidate: makeCandidate({ callAnthropicMessagesCountTokens }),
    headers: new Headers({ 'anthropic-beta': 'must-not-cross-source-protocols' }),
  });

  assertEquals(result.type, 'plain');
  if (result.type !== 'plain') throw new Error('unreachable');
  assertEquals(result.http.status, 200);
  const body = JSON.parse(decodeResponseBody(result.body));
  assertEquals(body, { totalTokens: 42 });
  assertEquals(callOptions?.anthropicBeta, []);
  assertEquals(callOptions?.headers.has('anthropic-beta'), false);
  // The Anthropic Messages count_tokens body should never carry the translation-time
  // `stream: true` flag — that field belongs to the streaming path only.
  if (upstreamBody === undefined) throw new Error('upstreamBody not captured');
  assertEquals('stream' in upstreamBody, false);
});

test('countTokens accepts the upstream total_tokens dialect', async () => {
  installRepo();
  const totalTokensResp = await geminiGenerateContentAttempt.countTokens({
    payload: makePayload(),
    ctx: makeGatewayCtx(),
    candidate: makeCandidate({
      callAnthropicMessagesCountTokens: async () => ({
        http: new Response(JSON.stringify({ total_tokens: 19 }), { status: 200, headers: new Headers({ 'content-type': 'application/json' }) }),
        modelKey: 'k',
      }),
    }),
    headers: new Headers(),
  });
  assertEquals(totalTokensResp.type, 'plain');
  if (totalTokensResp.type !== 'plain') throw new Error('unreachable');
  assertEquals(JSON.parse(decodeResponseBody(totalTokensResp.body)), { totalTokens: 19 });
});

test('countTokens runs the same shape cleanup chain generate does, and skips it natively', async () => {
  installRepo();
  let translatedBody: Record<string, unknown> | undefined;
  let nativeBody: Record<string, unknown> | undefined;

  const payload = makePayload({
    tools: [{ googleSearch: {} }, { functionDeclarations: [{ name: 'lookup' }] }],
    safetySettings: [{ category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' }],
    contents: [{ role: 'user', parts: [{ text: 'hi' }, { fileData: { fileUri: 'gs://bucket/f.pdf' } }] }],
  });

  await geminiGenerateContentAttempt.countTokens({
    payload,
    ctx: makeGatewayCtx(),
    candidate: makeCandidate({
      callAnthropicMessagesCountTokens: async (_model, body) => {
        translatedBody = body as Record<string, unknown>;
        return { http: Response.json({ input_tokens: 1 }), modelKey: 'k' };
      },
    }),
    headers: new Headers(),
  });

  await geminiGenerateContentAttempt.countTokens({
    payload,
    ctx: makeGatewayCtx(),
    candidate: makeCandidate({
      endpoints: { geminiGenerateContent: {} },
      callGeminiGenerateContentCountTokens: async (_model, body) => {
        nativeBody = body as Record<string, unknown>;
        return { http: Response.json({ totalTokens: 1 }), modelKey: 'k' };
      },
    }),
    headers: new Headers(),
  });

  // A translated target cannot express these fields, so the shared cleanup
  // removes them; a native upstream receives the payload as shaped.
  assertEquals(translatedBody?.safetySettings, undefined);
  assertEquals(nativeBody?.safetySettings, payload.safetySettings);
  assertEquals(nativeBody?.contents, payload.contents);
  assertEquals(nativeBody?.tools, payload.tools);
});

test('native countTokens clones rawJSON values and applies alias rules', async () => {
  installRepo();
  let capturedBody: Record<string, unknown> | undefined;
  const parsedArgs = parseJSONWithRawNumbers('{"huge":1e400}') as Record<string, unknown>;
  const payload = makePayload({
    contents: [{
      role: 'model',
      parts: [{ functionCall: { name: 'calc', args: parsedArgs } }],
    }],
  });

  const result = await geminiGenerateContentAttempt.countTokens({
    payload,
    ctx: makeGatewayCtx(),
    candidate: makeCandidate({
      endpoints: { geminiGenerateContent: {} },
      rules: { reasoning: { budget_tokens: 2048 } },
      callGeminiGenerateContentCountTokens: async (_model, body) => {
        capturedBody = body as Record<string, unknown>;
        return { http: Response.json({ totalTokens: 12 }), modelKey: 'k' };
      },
    }),
    headers: new Headers(),
  });

  assertEquals(result.type, 'plain');
  if (result.type !== 'plain') throw new Error('unreachable');
  assertEquals(JSON.parse(decodeResponseBody(result.body)), { totalTokens: 12 });
  assertEquals(capturedBody?.generationConfig, { thinkingConfig: { thinkingBudget: 2048 } });
  const forwardedArgs = (capturedBody?.contents as Array<{ parts?: Array<{ functionCall?: { args?: Record<string, unknown> } }> }>)[0]?.parts?.[0]?.functionCall?.args;
  assertEquals(JSON.stringify(forwardedArgs), '{"huge":1e400}');
});

test('translated countTokens uses trip.error for structured Anthropic upstream errors and falls back on non-JSON bodies', async () => {
  installRepo();
  const structuredResp = await geminiGenerateContentAttempt.countTokens({
    payload: makePayload(),
    ctx: makeGatewayCtx(),
    candidate: makeCandidate({
      callAnthropicMessagesCountTokens: async () => ({
        http: Response.json(
          { type: 'error', error: { type: 'invalid_request_error', message: 'messages is invalid' } },
          { status: 400, headers: { 'request-id': 'req-anthropic-err' } },
        ),
        modelKey: 'k',
      }),
    }),
    headers: new Headers(),
  });

  assertEquals(structuredResp.type, 'plain');
  if (structuredResp.type !== 'plain') throw new Error('unreachable');
  assertEquals(structuredResp.http.status, 400);
  assertEquals(structuredResp.http.headers.get('request-id'), 'req-anthropic-err');
  assertEquals(JSON.parse(decodeResponseBody(structuredResp.body)), {
    error: {
      code: 400,
      message: 'messages is invalid',
      status: 'INVALID_ARGUMENT',
      details: [{ '@type': 'type.googleapis.com/google.protobuf.Struct', value: { type: 'invalid_request_error' } }],
    },
  });

  const plainTextResp = await geminiGenerateContentAttempt.countTokens({
    payload: makePayload(),
    ctx: makeGatewayCtx(),
    candidate: makeCandidate({
      callAnthropicMessagesCountTokens: async () => ({
        http: new Response('upstream unavailable', { status: 503, headers: { 'content-type': 'text/plain' } }),
        modelKey: 'k',
      }),
    }),
    headers: new Headers(),
  });
  assertEquals(plainTextResp.type, 'plain');
  if (plainTextResp.type !== 'plain') throw new Error('unreachable');
  assertEquals(plainTextResp.http.status, 503);
  assertEquals(JSON.parse(decodeResponseBody(plainTextResp.body)), {
    error: { code: 503, message: 'upstream unavailable', status: 'UNAVAILABLE' },
  });
});
