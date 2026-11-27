import { expect, test, vi } from 'vitest';

import { openaiResponsesAttempt } from '../../../../src/data-plane/chat/openai-responses/attempt.ts';
import { initRepo } from '../../../../src/repo/index.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { mockChatGatewayCtx } from '../../../test-utils/gateway-ctx.ts';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type {
  GeminiGenerateContentPayload,
  GeminiGenerateContentStreamEvent,
} from '@floway-dev/protocols/gemini-generate-content';
import {
  collectOpenAIResponsesProtocolEventsToResult,
  type CanonicalOpenAIResponsesPayload,
} from '@floway-dev/protocols/openai-responses';
import { stubUpstream, stubUpstreamModel } from '@floway-dev/test-utils';
import {
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
    upstreamId: 'up_gemini_resp',
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

test('routes OpenAI Responses to Gemini, strips model, and lowers agent_message before translation', async () => {
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
          responseId: 'gem_resp_gw',
          modelVersion: 'gemini-2.5-pro',
          candidates: [{
            index: 0,
            content: {
              role: 'model',
              parts: [
                { thought: true, text: 'Gemini thought.' },
                { text: 'Responses answer from Gemini!' },
              ],
            },
            finishReason: 'STOP',
          }],
          usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 6, thoughtsTokenCount: 2, totalTokenCount: 17 },
        },
      ]),
    };
  });

  const payload: CanonicalOpenAIResponsesPayload = {
    model: 'gemini-2.5-pro',
    instructions: 'Follow Codex protocol.',
    reasoning: { effort: 'medium' },
    input: [
      { type: 'agent_message', author: 'lead', recipient: 'worker', content: [{ type: 'input_text', text: 'Subagent task prompt' }] },
      { type: 'message', role: 'user', content: 'Hello from Codex client' },
    ],
  };

  const result = await openaiResponsesAttempt.generate({
    payload,
    ctx: mockChatGatewayCtx({ apiKeyId: 'key_resp_gem', wantsStream: true }),
    candidate: makeCandidate(callGeminiGenerateContent),
    headers: new Headers(),
  });

  expect(capturedBody).toBeDefined();
  expect('model' in capturedBody!).toBe(false);
  expect(capturedBody).toMatchObject({
    systemInstruction: { parts: [{ text: 'Follow Codex protocol.' }] },
    contents: [{
      role: 'user',
      parts: [
        { text: expect.stringContaining('Subagent task prompt') },
        { text: 'Hello from Codex client' },
      ],
    }],
    generationConfig: {
      thinkingConfig: { thinkingLevel: 'MEDIUM', includeThoughts: true },
    },
  });

  expect(result.type).toBe('events');
  if (result.type !== 'events') throw new Error('Expected streaming events result');
  const assembled = await collectOpenAIResponsesProtocolEventsToResult(result.events);
  expect(assembled.output).toEqual(expect.arrayContaining([
    expect.objectContaining({
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: 'Gemini thought.' }],
    }),
    expect.objectContaining({
      type: 'message',
      content: [expect.objectContaining({ type: 'output_text', text: 'Responses answer from Gemini!' })],
    }),
  ]));
});

test('keeps raw JSON numbers from tool calls and outputs on the Gemini wire and pivots compact via the shim', async () => {
  initRepo(new InMemoryRepo());
  let wireBody = '';
  const callGeminiGenerateContent = vi.fn(async (_model, body: GeminiGenerateContentPayload): Promise<UpstreamStreamResult<GeminiGenerateContentStreamEvent>> => {
    wireBody = JSON.stringify(body);
    return {
      ok: true,
      modelKey: 'gemini-2.5-pro',
      http: { status: 200, headers: new Headers() },
      events: makeProtocolFrames<GeminiGenerateContentStreamEvent>([{
        modelVersion: 'gemini-2.5-pro',
        candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'Compacted summary.' }] }, finishReason: 'STOP' }],
      }]),
    };
  });

  const payload: CanonicalOpenAIResponsesPayload = {
    model: 'gemini-2.5-pro',
    input: [
      { type: 'message', role: 'user', content: 'Score it.' },
      { type: 'function_call', call_id: 'call_score', name: 'score', arguments: '{"threshold":1.0}' },
      { type: 'function_call_output', call_id: 'call_score', output: '{"score":12.50}' },
    ],
    tools: [{ type: 'function', name: 'score', parameters: { type: 'object' } }],
  };

  const result = await openaiResponsesAttempt.generate({
    payload,
    ctx: mockChatGatewayCtx({ apiKeyId: 'key_resp_gem_raw', wantsStream: true }),
    candidate: makeCandidate(callGeminiGenerateContent),
    headers: new Headers(),
  });

  expect(result.type).toBe('events');
  if (result.type !== 'events') throw new Error('Expected streaming events result');
  await collectOpenAIResponsesProtocolEventsToResult(result.events);
  expect(wireBody).toContain('"args":{"threshold":1.0}');
  expect(wireBody).toContain('"response":{"score":12.50}');

  const compacted = await openaiResponsesAttempt.invoke({
    action: 'compact',
    payload: {
      model: 'gemini-2.5-pro',
      input: [{ type: 'message', role: 'user', content: 'Summarize this conversation.' }],
    },
    ctx: mockChatGatewayCtx({ apiKeyId: 'key_resp_gem_compact', wantsStream: false }),
    candidate: makeCandidate(callGeminiGenerateContent),
    headers: new Headers(),
  });
  expect(callGeminiGenerateContent).toHaveBeenCalledTimes(2);
  expect(compacted.type).toBe('result');
  if (compacted.type !== 'result') throw new Error('Expected compacted result');
  expect(compacted.result.output).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: 'compaction' }),
  ]));
});
