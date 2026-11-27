import { expect, test, vi } from 'vitest';

import {
  anthropicMessagesAttempt,
  anthropicMessagesCountTokensTarget,
  anthropicMessagesGenerateTarget,
} from '../../../../src/data-plane/chat/anthropic-messages/attempt.ts';
import { initRepo } from '../../../../src/repo/index.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { mockChatGatewayCtx } from '../../../test-utils/gateway-ctx.ts';
import {
  collectAnthropicMessagesProtocolEventsToResult,
  type AnthropicMessagesPayload,
} from '@floway-dev/protocols/anthropic-messages';
import { eventFrame, type ModelEndpoints, type ProtocolFrame } from '@floway-dev/protocols/common';
import type {
  GeminiGenerateContentPayload,
  GeminiGenerateContentStreamEvent,
} from '@floway-dev/protocols/gemini-generate-content';
import {
  decodeResponseBody,
  directFetcher,
  type ModelCandidate,
  type ProviderCallResult,
  type ProviderStreamResult,
  type UpstreamCallOptions,
} from '@floway-dev/provider';
import type { FlagId } from '@floway-dev/provider/flags';
import { stubProvider, stubProviderModel } from '@floway-dev/test-utils';

const makeProtocolFrames = async function* <TEvent>(events: readonly TEvent[]): AsyncGenerator<ProtocolFrame<TEvent>> {
  for (const event of events) yield eventFrame(event);
};

const makeCandidate = (overrides: {
  endpoints: ModelEndpoints;
  maxOutputTokens?: number;
  enabledFlags?: ReadonlySet<FlagId>;
  inboundHeaderAllowlist?: readonly string[];
  callGeminiGenerateContent?: (
    model: unknown,
    body: GeminiGenerateContentPayload,
    signal?: AbortSignal,
    opts?: UpstreamCallOptions,
  ) => Promise<ProviderStreamResult<GeminiGenerateContentStreamEvent>>;
  callGeminiGenerateContentCountTokens?: (
    model: unknown,
    body: GeminiGenerateContentPayload,
    signal?: AbortSignal,
    opts?: UpstreamCallOptions,
  ) => Promise<ProviderCallResult>;
}): ModelCandidate => {
  const upstream = 'up_gemini_msg';
  const instance = stubProvider({
    callGeminiGenerateContent: overrides.callGeminiGenerateContent,
    callGeminiGenerateContentCountTokens: overrides.callGeminiGenerateContentCountTokens,
  });
  return {
    provider: {
      upstreamId: upstream,
      kind: 'custom',
      name: 'Gemini Upstream',
      inboundHeaderAllowlist: [...(overrides.inboundHeaderAllowlist ?? [])],
      instance,
    },
    model: stubProviderModel({
      id: 'gemini-2.5-pro',
      upstreamModelId: 'gemini-2.5-pro',
      endpoints: overrides.endpoints,
      ...(overrides.enabledFlags === undefined ? {} : { enabledFlags: new Set(overrides.enabledFlags) }),
      ...(overrides.maxOutputTokens === undefined ? {} : { limits: { max_output_tokens: overrides.maxOutputTokens } }),
    }),
    fetcher: directFetcher,
  };
};

test('routes Anthropic Messages generate and count_tokens to a Gemini-only candidate while keeping native targets first', async () => {
  initRepo(new InMemoryRepo());

  expect(anthropicMessagesGenerateTarget.pick({ openaiChatCompletions: {}, geminiGenerateContent: {} })).toBe('openaiChatCompletions');
  expect(anthropicMessagesGenerateTarget.pick({ openaiResponses: {}, geminiGenerateContent: {} })).toBe('openaiResponses');
  expect(anthropicMessagesGenerateTarget.pick({ anthropicMessages: {}, geminiGenerateContent: {} })).toBe('anthropicMessages');
  expect(anthropicMessagesGenerateTarget.pick({ geminiGenerateContent: {} })).toBe('geminiGenerateContent');
  expect(anthropicMessagesCountTokensTarget.pick({ anthropicMessages: {}, geminiGenerateContent: {} })).toBe('anthropicMessages');
  expect(anthropicMessagesCountTokensTarget.pick({ geminiGenerateContent: {} })).toBe('geminiGenerateContent');

  let capturedBody: GeminiGenerateContentPayload | undefined;
  const callGeminiGenerateContent = vi.fn(async (_model, body: GeminiGenerateContentPayload): Promise<ProviderStreamResult<GeminiGenerateContentStreamEvent>> => {
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
    candidate: makeCandidate({
      endpoints: { geminiGenerateContent: {} },
      callGeminiGenerateContent,
    }),
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
});

test('retains Gemini thought parts and thoughtSignature on translated turns even when the caller omits thinking config', async () => {
  initRepo(new InMemoryRepo());
  const ctx = mockChatGatewayCtx({ apiKeyId: 'key_msg_gem_sig', wantsStream: true });
  const callBodies: GeminiGenerateContentPayload[] = [];

  const callGeminiGenerateContent = vi.fn(async (_model, body: GeminiGenerateContentPayload): Promise<ProviderStreamResult<GeminiGenerateContentStreamEvent>> => {
    callBodies.push(body);
    if (callBodies.length === 1) {
      return {
        ok: true,
        modelKey: 'gemini-2.5-pro',
        http: { status: 200, headers: new Headers() },
        events: makeProtocolFrames<GeminiGenerateContentStreamEvent>([{
          responseId: 'gem_turn_1',
          modelVersion: 'gemini-2.5-pro',
          candidates: [{
            index: 0,
            content: {
              role: 'model',
              parts: [
                { thought: true, text: 'Default model thought.', thoughtSignature: 'sig_default_thought' },
                { functionCall: { name: 'lookup', args: { q: 'docs' } }, thoughtSignature: 'sig_default_call' },
              ],
            },
            finishReason: 'STOP',
          }],
        }]),
      };
    }
    return {
      ok: true,
      modelKey: 'gemini-2.5-pro',
      http: { status: 200, headers: new Headers() },
      events: makeProtocolFrames<GeminiGenerateContentStreamEvent>([{
        responseId: 'gem_turn_2',
        modelVersion: 'gemini-2.5-pro',
        candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'Done.' }] }, finishReason: 'STOP' }],
      }]),
    };
  });

  const candidate = makeCandidate({ endpoints: { geminiGenerateContent: {} }, callGeminiGenerateContent });
  const turn1 = await anthropicMessagesAttempt.generate({
    payload: {
      model: 'gemini-2.5-pro',
      max_tokens: 512,
      tools: [{ name: 'lookup', input_schema: { type: 'object', properties: { q: { type: 'string' } } } }],
      messages: [{ role: 'user', content: 'Look up docs' }],
    },
    ctx,
    candidate,
    headers: new Headers(),
    anthropicBeta: [],
  });
  if (turn1.type !== 'events') throw new Error('Expected turn 1 events');
  const firstReply = await collectAnthropicMessagesProtocolEventsToResult(turn1.events);
  const toolUse = firstReply.content.find(block => block.type === 'tool_use');
  if (toolUse === undefined) throw new Error('Expected tool_use');

  const turn2 = await anthropicMessagesAttempt.generate({
    payload: {
      model: 'gemini-2.5-pro',
      max_tokens: 512,
      tools: [{ name: 'lookup', input_schema: { type: 'object', properties: { q: { type: 'string' } } } }],
      messages: [
        { role: 'user', content: 'Look up docs' },
        { role: 'assistant', content: firstReply.content },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: 'Found' }] },
      ],
    },
    ctx,
    candidate,
    headers: new Headers(),
    anthropicBeta: [],
  });
  expect(turn2.type).toBe('events');
  expect(callBodies[1]?.contents[1]).toEqual({
    role: 'model',
    parts: [
      { thought: true, text: 'Default model thought.', thoughtSignature: 'sig_default_thought' },
      { functionCall: { name: 'lookup', args: { q: 'docs' } }, thoughtSignature: 'sig_default_call' },
    ],
  });
});

test('translates Anthropic Messages count_tokens to Gemini countTokens, preserves request interceptors, and reshapes responses and errors', async () => {
  initRepo(new InMemoryRepo());
  let capturedBody: GeminiGenerateContentPayload | undefined;
  let capturedHeaders: Headers | undefined;
  const callGeminiGenerateContentCountTokens = vi.fn(async (_model, body: GeminiGenerateContentPayload, _signal, opts?: UpstreamCallOptions): Promise<ProviderCallResult> => {
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
      tools: [{ name: 'lookup', input_schema: { type: 'object', properties: { q: { type: 'string' } } } }],
      messages: [
        { role: 'user', content: 'Look up metric' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'lookup', input: { q: 'latency' } }] },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_1', content: '{"score":1.0,"id":9007199254740993}' },
            { type: 'text', text: 'How many tokens?' },
          ],
        },
      ],
    } as AnthropicMessagesPayload,
    ctx,
    candidate: makeCandidate({
      endpoints: { geminiGenerateContent: {} },
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
  const serializedBody = JSON.stringify(capturedBody);
  expect(serializedBody).toContain('"response":{"score":1.0,"id":9007199254740993}');
  expect(JSON.parse(serializedBody)).toEqual({
    tools: [{ functionDeclarations: [{ name: 'lookup', parametersJsonSchema: { type: 'object', properties: { q: { type: 'string' } } } }] }],
    systemInstruction: { parts: [{ text: 'Count rules.' }] },
    contents: [
      { role: 'user', parts: [{ text: 'Look up metric' }] },
      {
        role: 'model',
        parts: [{
          functionCall: { id: 'toolu_1', name: 'lookup', args: { q: 'latency' } },
          thoughtSignature: 'skip_thought_signature_validator',
        }],
      },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'toolu_1',
              name: 'lookup',
              response: { score: 1, id: 9007199254740992 },
            },
          },
          { text: 'How many tokens?' },
        ],
      },
    ],
  });

  const rateLimited = await anthropicMessagesAttempt.countTokens({
    payload: { model: 'gemini-2.5-pro', messages: [{ role: 'user', content: 'hi' }] } as AnthropicMessagesPayload,
    ctx,
    candidate: makeCandidate({
      endpoints: { geminiGenerateContent: {} },
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
    error: { type: 'rate_limit_error', message: 'Quota exceeded' },
  });

  const malformed = await anthropicMessagesAttempt.countTokens({
    payload: { model: 'gemini-2.5-pro', messages: [{ role: 'user', content: 'hi' }] } as AnthropicMessagesPayload,
    ctx,
    candidate: makeCandidate({
      endpoints: { geminiGenerateContent: {} },
      callGeminiGenerateContentCountTokens: async () => ({
        http: new Response(JSON.stringify({ unexpected: true }), {
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
        }),
        modelKey: 'gemini-2.5-pro',
      }),
    }),
    headers: new Headers(),
    anthropicBeta: [],
  });
  expect(malformed.type).toBe('api-error');
  expect(malformed.http.status).toBe(502);
  expect(JSON.parse(decodeResponseBody(malformed.body))).toMatchObject({
    type: 'error',
    error: { type: 'api_error' },
  });

  const empty204 = await anthropicMessagesAttempt.countTokens({
    payload: { model: 'gemini-2.5-pro', messages: [{ role: 'user', content: 'hi' }] } as AnthropicMessagesPayload,
    ctx,
    candidate: makeCandidate({
      endpoints: { geminiGenerateContent: {} },
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
    candidate: makeCandidate({ endpoints: { geminiGenerateContent: {} } }),
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
