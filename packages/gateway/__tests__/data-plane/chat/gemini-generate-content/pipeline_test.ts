import { expect, test } from 'vitest';

import { collectGeminiGenerateContent, collectGeminiGenerateContentStreamError, encodeGeminiGenerateContent } from '../../../../src/data-plane/chat/gemini-generate-content/encode.ts';
import { stripSafetySettings } from '../../../../src/data-plane/chat/gemini-generate-content/interceptors/strip-safety-settings.ts';
import { stripUnsupportedPartFields } from '../../../../src/data-plane/chat/gemini-generate-content/interceptors/strip-unsupported-part-fields.ts';
import { stripUnsupportedTools } from '../../../../src/data-plane/chat/gemini-generate-content/interceptors/strip-unsupported-tools.ts';
import { suppressThoughtParts } from '../../../../src/data-plane/chat/gemini-generate-content/interceptors/suppress-thought-parts.ts';
import { parseGeminiGenerateContent, type GeminiGenerateContentDelivery } from '../../../../src/data-plane/chat/gemini-generate-content/parse.ts';
import { collectChat } from '../../../../src/data-plane/chat/shared/collect.ts';
import { localResponseHead } from '../../../../src/data-plane/pipeline/encode.ts';
import type { GatewayPipelineFacts } from '../../../../src/data-plane/pipeline/facts.ts';
import type { GatewayServices } from '../../../../src/data-plane/pipeline/services.ts';
import { stubChatCandidate } from '../shared/affinity/helpers.ts';
import { factSpace, run, type Result } from '@floway-dev/pipeline';
import type { GeminiGenerateContentPayload, GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';
import type { ProtocolStreamError } from '@floway-dev/provider';

type Frame = Result<GeminiGenerateContentStreamEvent, ProtocolStreamError>;
type UpstreamAnswer = { frames: readonly Frame[] } | { status: number; body: unknown };
const { compose, defineStage } = factSpace<GatewayPipelineFacts & { 'request.delivery': GeminiGenerateContentDelivery; 'request.model': string }, GatewayServices>();

const chunk: GeminiGenerateContentStreamEvent = {
  candidates: [{ content: { role: 'model', parts: [{ text: 'hello' }] }, finishReason: 'STOP' }],
};

const serve = async (action: string, upstream: UpstreamAnswer, request: Record<string, unknown> = { contents: [] }, native = true) => {
  let model: string | undefined;
  let delivery: GeminiGenerateContentDelivery | undefined;
  let upstreamRequest: GeminiGenerateContentPayload | undefined;
  const ending = defineStage({
    name: 'gemini-upstream',
    request: { needs: ['request.geminiGenerateContent', 'request.model', 'request.delivery'] },
    return: { provides: ['response.http', 'response.geminiGenerateContent'] },
    async execute(facts, scope) {
      model = facts['request.model'];
      delivery = facts['request.delivery'];
      upstreamRequest = facts['request.geminiGenerateContent'];
      return {
        'response.http': { ...localResponseHead('status' in upstream ? upstream.status : 200), headers: [['x-upstream', 'kept']], body: null },
        'response.geminiGenerateContent': 'status' in upstream
          ? { kind: 'error', source: 'upstream', error: upstream.body }
          : { kind: 'stream', stream: scope.createStream(async function* () { yield* upstream.frames; }) },
      };
    },
  });
  const pipeline = compose('gemini-test', {
    entry: ['request.http', 'provider.model'],
    exit: ['response.http', 'response.outcome'],
    stages: [
      parseGeminiGenerateContent, encodeGeminiGenerateContent,
      collectChat('geminiGenerateContent', collectGeminiGenerateContent, collectGeminiGenerateContentStreamError),
      stripUnsupportedPartFields, stripUnsupportedTools, stripSafetySettings, suppressThoughtParts,
    ],
    ending,
  });
  const running = run(pipeline, {
    'provider.model': stubChatCandidate({ model: { endpoints: native ? { geminiGenerateContent: {} } : { anthropicMessages: {} } } }).model,
    'request.http': {
      url: `https://floway.test/v1beta/models/models/gemini-test:${action}`,
      method: 'POST',
      headers: [],
      body: new TextEncoder().encode(JSON.stringify(request)),
    },
  }, { services: {} as GatewayServices, signal: new AbortController().signal, waitUntil: () => {} });
  const answer = await running.result;
  const response = answer['response.http']!;
  const completed = running.read(answer['response.outcome']);
  const decoder = new TextDecoder();
  let body = '';
  if (response.body instanceof Uint8Array) body = decoder.decode(response.body);
  else if (response.body !== null) {
    for await (const item of running.read(response.body)) {
      if (!item.ok) throw new Error('Expected encoded body bytes', { cause: item.error.cause });
      body += decoder.decode(item.value, { stream: true });
    }
    body += decoder.decode();
  }
  await running.done;
  return { response, body, model, delivery, upstreamRequest, outcome: await completed };
};

test('the URL action supplies model and delivery for incremental JSON collection', async () => {
  const { response, body, model, delivery } = await serve('generateContent', { frames: [{ ok: true, value: chunk }] });
  expect(model).toBe('gemini-test');
  expect(delivery).toEqual({ stream: false });
  expect(response.status).toBe(200);
  expect(JSON.parse(body)).toMatchObject(chunk);
});

test('Gemini sends its native in-stream error as bare JSON after the SSE prefix', async () => {
  const event = { error: { code: 429, message: 'busy', status: 'RESOURCE_EXHAUSTED' } };
  const error = { kind: 'protocol', cause: new Error('busy'), event } as const;
  const { body, delivery } = await serve('streamGenerateContent', { frames: [{ ok: true, value: chunk }, { ok: false, error }] });
  expect(delivery).toEqual({ stream: true });
  expect(body).toBe(`data: ${JSON.stringify(chunk)}\n\n${JSON.stringify(event)}`);
});

test('Gemini retains the status from a native RPC error body and forwards headers', async () => {
  const upstream = { error: { code: 429, message: 'busy', status: 'RESOURCE_EXHAUSTED' } };
  const { response, body } = await serve('generateContent', { status: 418, body: upstream });
  expect(response.status).toBe(429);
  expect(response.headers).toContainEqual(['x-upstream', 'kept']);
  expect(JSON.parse(body)).toEqual(upstream);
});

test('Gemini lifts an unmapped status to INTERNAL while retaining its JSON body', async () => {
  const upstream = { message: 'unknown upstream status' };
  const { response, body } = await serve('generateContent', { status: 418, body: upstream });
  expect(response.status).toBe(500);
  expect(JSON.parse(body)).toEqual(upstream);
});

test.each([418, 500])('Gemini renders the RPC code for a native or synthesized envelope (code=%i)', async code => {
  const error = { error: { code, status: 'INTERNAL', message: 'Upstream failure' } };
  const { response, body } = await serve('generateContent', { status: 418, body: error });
  expect(response.status).toBe(code);
  expect(JSON.parse(body)).toEqual(error);
});

test('an unknown action is rejected before the provider', async () => {
  const { response, body, model } = await serve('badAction', { frames: [] });
  expect(response.status).toBe(404);
  expect(JSON.parse(body)).toMatchObject({ error: { status: 'NOT_FOUND', message: 'Unknown Gemini model action: badAction' } });
  expect(model).toBeUndefined();
});

test.each([false, true])('Gemini translation shapes only unsupported fields and suppresses unrequested thoughts (includeThoughts=%s)', async includeThoughts => {
  const contents = [{ role: 'user', parts: [{ text: 'hello' }, { fileData: { fileUri: 'gs://file' } }] }];
  const request = {
    contents,
    tools: [{ googleSearch: {} }, { functionDeclarations: [{ name: 'hello' }], urlContext: {} }],
    safetySettings: [{ category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' }],
    generationConfig: { thinkingConfig: { includeThoughts } },
  };
  const upstream: UpstreamAnswer = {
    frames: [{
      ok: true, value: {
        candidates: [
          { index: 0, content: { role: 'model', parts: [{ text: 'thought-summary', thought: true }] } },
          { index: 1, content: { role: 'model', parts: [{ text: 'answer' }] }, finishReason: 'STOP' },
        ],
      },
    }],
  };
  const native = await serve('streamGenerateContent', upstream, request);
  expect(native.upstreamRequest).toEqual(request);
  expect(native.body).toContain('thought-summary');

  const translated = await serve('streamGenerateContent', upstream, request, false);
  expect(translated.upstreamRequest).toMatchObject({
    contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
    tools: [{ functionDeclarations: [{ name: 'hello' }] }],
  });
  expect(translated.upstreamRequest).not.toHaveProperty('safetySettings');
  expect(translated.body.includes('thought-summary')).toBe(includeThoughts);
  expect(translated.body).toContain('answer');
});
