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
  const upstream = 'up_gemini_msg';
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

test('routes Anthropic Messages generate to a Gemini-only candidate, keeps geminiGenerateContent last, and leaves count_tokens native-only', async () => {
  initRepo(new InMemoryRepo());

  expect(anthropicMessagesGenerateTarget.canServe({ geminiGenerateContent: {} })).toBe(true);
  expect(anthropicMessagesGenerateTarget.pick({ openaiChatCompletions: {}, geminiGenerateContent: {} })).toBe('openaiChatCompletions');
  expect(anthropicMessagesGenerateTarget.pick({ openaiResponses: {}, geminiGenerateContent: {} })).toBe('openaiResponses');
  expect(anthropicMessagesGenerateTarget.pick({ anthropicMessages: {}, geminiGenerateContent: {} })).toBe('anthropicMessages');
  expect(anthropicMessagesGenerateTarget.pick({ geminiGenerateContent: {} })).toBe('geminiGenerateContent');
  expect(anthropicMessagesCountTokensTarget.canServe({ geminiGenerateContent: {} })).toBe(false);

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

  expect(callGeminiGenerateContent).toHaveBeenCalledTimes(1);
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
