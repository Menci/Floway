import { expect, test, vi } from 'vitest';

import {
  openaiChatCompletionsAttempt,
  openaiChatCompletionsTarget,
} from '../../../../src/data-plane/chat/openai-chat-completions/attempt.ts';
import { initRepo } from '../../../../src/repo/index.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { mockChatGatewayCtx } from '../../../test-utils/gateway-ctx.ts';
import { eventFrame, type ModelEndpoints, type ProtocolFrame } from '@floway-dev/protocols/common';
import type {
  GeminiGenerateContentPayload,
  GeminiGenerateContentStreamEvent,
} from '@floway-dev/protocols/gemini-generate-content';
import {
  collectOpenAIChatCompletionsProtocolEventsToResult,
  type OpenAIChatCompletionsPayload,
} from '@floway-dev/protocols/openai-chat-completions';
import {
  directFetcher,
  type ModelCandidate,
  type ProviderStreamResult,
  type UpstreamCallOptions,
} from '@floway-dev/provider';
import { stubProvider, stubProviderModel } from '@floway-dev/test-utils';

const makeProtocolFrames = async function* <TEvent>(events: readonly TEvent[]): AsyncGenerator<ProtocolFrame<TEvent>> {
  for (const event of events) yield eventFrame(event);
};

const makeCandidate = (overrides: {
  endpoints: ModelEndpoints;
  maxOutputTokens?: number;
  callGeminiGenerateContent?: (
    model: unknown,
    body: GeminiGenerateContentPayload,
    signal?: AbortSignal,
    opts?: UpstreamCallOptions,
  ) => Promise<ProviderStreamResult<GeminiGenerateContentStreamEvent>>;
}): ModelCandidate => {
  const upstream = 'up_gemini_chat';
  const instance = stubProvider({
    callGeminiGenerateContent: overrides.callGeminiGenerateContent,
  });
  return {
    provider: {
      upstreamId: upstream,
      kind: 'custom',
      name: 'Gemini Upstream',
      inboundHeaderAllowlist: [],
      instance,
    },
    model: stubProviderModel({
      id: 'gemini-2.5-pro',
      upstreamModelId: 'gemini-2.5-pro',
      endpoints: overrides.endpoints,
      ...(overrides.maxOutputTokens === undefined ? {} : { limits: { max_output_tokens: overrides.maxOutputTokens } }),
    }),
    fetcher: directFetcher,
  };
};

test('routes OpenAI Chat Completions to a Gemini-only candidate, strips model from wire body, and keeps geminiGenerateContent last in target preference', async () => {
  initRepo(new InMemoryRepo());

  expect(openaiChatCompletionsTarget.pick({ openaiResponses: {}, geminiGenerateContent: {} })).toBe('openaiResponses');
  expect(openaiChatCompletionsTarget.pick({ anthropicMessages: {}, geminiGenerateContent: {} })).toBe('anthropicMessages');
  expect(openaiChatCompletionsTarget.pick({ openaiChatCompletions: {}, geminiGenerateContent: {} })).toBe('openaiChatCompletions');
  expect(openaiChatCompletionsTarget.pick({ geminiGenerateContent: {} })).toBe('geminiGenerateContent');

  let capturedBody: GeminiGenerateContentPayload | undefined;
  const callGeminiGenerateContent = vi.fn(async (_model, body: GeminiGenerateContentPayload): Promise<ProviderStreamResult<GeminiGenerateContentStreamEvent>> => {
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
    candidate: makeCandidate({
      endpoints: { geminiGenerateContent: {} },
      maxOutputTokens: 65536,
      callGeminiGenerateContent,
    }),
    headers: new Headers(),
  });

  expect(capturedBody).toBeDefined();
  expect('model' in capturedBody!).toBe(false);
  expect(capturedBody).toMatchObject({
    systemInstruction: { parts: [{ text: 'Be concise.' }] },
    contents: [{ role: 'user', parts: [{ text: 'Say hello' }] }],
    generationConfig: {
      maxOutputTokens: 65536,
      thinkingConfig: { thinkingLevel: 'HIGH', includeThoughts: true },
    },
  });

  expect(result.type).toBe('events');
  if (result.type !== 'events') throw new Error('Expected streaming events result');
  const assembled = await collectOpenAIChatCompletionsProtocolEventsToResult(result.events);
  expect(assembled.choices[0].message.content).toBe('Hello from Gemini!');
  expect(assembled.choices[0].message.reasoning_text).toBe('Visible reasoning.');
  expect(assembled.choices[0].finish_reason).toBe('stop');
});
