import { beforeEach, expect, test } from 'vitest';

import type { Candidate } from '../../../../../../src/data-plane/pipeline/facts.ts';
import { initRepo } from '../../../../../../src/repo/index.ts';
import { InMemoryRepo } from '../../../../../repo/memory.ts';
import { candidateFor } from '../../../../pipeline/fixtures.ts';
import { responsesTestServices } from '../fixtures.ts';
import { responsesTurn, runScriptedResponses, type ScriptedResponsesTurn } from '../scripted-responses.ts';
import type { Fetcher } from '@floway-dev/http';
import { createInMemoryImageProcessor, initExternalResourceFetcher, initImageProcessor } from '@floway-dev/platform';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { CanonicalOpenAIResponsesInputItem, CanonicalOpenAIResponsesPayload, OpenAIResponsesResultEx, OpenAIResponsesStreamEventEx, OpenAIResponsesToolChoice } from '@floway-dev/protocols/openai-responses';
import { assert, assertEquals } from '@floway-dev/test-utils';

interface ImageEditWireRequest {
  images: File[];
  mask: File | null;
}

let repo: InMemoryRepo;
const stub = {
  generationsCalls: [] as Record<string, unknown>[],
  editsRequests: [] as ImageEditWireRequest[],
  nextGenerations: [] as Response[],
  nextEdits: [] as Response[],
  nextResolutionOverride: null as { candidates: readonly Candidate[]; sawModel: boolean } | null,
};

const imageCandidate = (endpoints: Candidate['model']['endpoints'] = { openaiImagesGenerations: {}, openaiImagesEdits: {} }): Candidate => {
  const base = candidateFor('u');
  return {
    upstream: {
      ...base.upstream,
      config: { baseUrl: 'https://images.example.test', apiKey: '', ingressHeadersRules: [], endpoints, modelsFetch: { enabled: false, authStyle: 'bearer' } },
    },
    model: { ...base.model, id: 'gpt-image-2', upstreamModelId: 'gpt-image-2', kind: 'image', endpoints },
  };
};

const fetcher: Fetcher = async (url, init) => {
  const path = new URL(url).pathname;
  if (path === '/v1/images/generations') {
    if (typeof init.body !== 'string') throw new Error('Expected image generations JSON');
    stub.generationsCalls.push(JSON.parse(init.body) as Record<string, unknown>);
    const response = stub.nextGenerations.shift();
    if (response === undefined) throw new Error('Missing fixture generations response');
    return response;
  }
  if (path === '/v1/images/edits') {
    if (!(init.body instanceof Uint8Array)) throw new Error('Expected image edits multipart bytes');
    const form = await new Response(new Uint8Array(init.body), { headers: new Headers(init.headers) }).formData();
    const images = [...form.getAll('image[]'), ...form.getAll('image')];
    const mask = form.get('mask');
    if (!images.every(image => image instanceof File) || (mask !== null && !(mask instanceof File))) throw new Error('Expected multipart file parts');
    stub.editsRequests.push({ images, mask });
    const response = stub.nextEdits.shift();
    if (response === undefined) throw new Error('Missing fixture edits response');
    return response;
  }
  throw new Error(`Unexpected image request path ${path}`);
};

const shim = (
  request: { payload: CanonicalOpenAIResponsesPayload },
  next: () => Promise<ScriptedResponsesTurn>,
) => runScriptedResponses({
  payload: request.payload,
  target: 'openaiResponses',
  flags: ['openai-responses-image-generation-shim'],
  services: {
    ...responsesTestServices('key_test'),
    catalogCandidates: async () => stub.nextResolutionOverride ?? { candidates: [imageCandidate()], sawModel: true },
    fetcher: () => fetcher,
  },
  next(payload) {
    request.payload = payload;
    return next();
  },
});

const emptyResult = (status: OpenAIResponsesResultEx['status']): OpenAIResponsesResultEx => ({
  id: 'upstream', object: 'response', model: 'orchestrator', output: [], status, error: null, incomplete_details: null,
});

const jsonResponse = (b64: string): Response =>
  new Response(JSON.stringify({ data: [{ b64_json: b64 }] }), { status: 200, headers: new Headers({ 'content-type': 'application/json' }) });

const REMOTE_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/wEAAAAASUVORK5CYII=';
const remotePngResponse = (): Response => new Response(Uint8Array.from(atob(REMOTE_PNG_B64), c => c.charCodeAt(0)));

const sseResponse = (lines: string[]): Response =>
  new Response(lines.map(l => `data: ${l}\n\n`).join(''), { status: 200, headers: new Headers({ 'content-type': 'text/event-stream' }) });

const rateLimitResponse = (retryAfterMs: number | null): Response => {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (retryAfterMs !== null) headers['retry-after-ms'] = String(retryAfterMs);
  return new Response(
    JSON.stringify({ error: { code: 'RateLimitReached', type: 'image_generation_error', message: 'rate limited' } }),
    { status: 429, headers },
  );
};

// One scripted upstream turn: the orchestrator calls image_generation with the
// given prompt, then the upstream completes.
const callTurn = (outputIndex: number, callId: string, prompt: string, args = JSON.stringify({ prompt })): ProtocolFrame<OpenAIResponsesStreamEventEx>[] => {
  return [
    eventFrame({ type: 'response.created', response: emptyResult('in_progress') }),
    eventFrame({ type: 'response.output_item.added', output_index: outputIndex, item: { type: 'function_call', call_id: callId, name: 'image_generation', arguments: '', status: 'in_progress' } }),
    eventFrame({ type: 'response.output_item.done', output_index: outputIndex, item: { type: 'function_call', call_id: callId, name: 'image_generation', arguments: args, status: 'completed' } }),
    eventFrame({ type: 'response.completed', response: emptyResult('completed') }),
  ] as ProtocolFrame<OpenAIResponsesStreamEventEx>[];
};

const messageTurn = (text: string): ProtocolFrame<OpenAIResponsesStreamEventEx>[] => [
  eventFrame({ type: 'response.created', response: emptyResult('in_progress') }),
  eventFrame({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', role: 'assistant', content: [], status: 'in_progress' } }),
  eventFrame({ type: 'response.output_item.done', output_index: 0, item: { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] } }),
  eventFrame({ type: 'response.completed', response: emptyResult('completed') }),
] as ProtocolFrame<OpenAIResponsesStreamEventEx>[];

const scriptedRun = (turns: ProtocolFrame<OpenAIResponsesStreamEventEx>[][]) => {
  let i = 0;
  return async (): Promise<ScriptedResponsesTurn> => {
    if (i >= turns.length) throw new Error(`unexpected run() call ${i + 1}; only ${turns.length} scripted`);
    const frames = turns[i++];
    return responsesTurn((async function* () { yield* frames; })());
  };
};

const makeCtx = (
  input: CanonicalOpenAIResponsesInputItem[],
  action: 'generate' | 'edit' | 'auto' = 'auto',
  extraTool: Record<string, unknown> = {},
  toolChoice?: OpenAIResponsesToolChoice,
): { payload: CanonicalOpenAIResponsesPayload } => ({
  payload: {
    model: 'orchestrator',
    input,
    tools: [{ type: 'image_generation', action, ...extraTool }],
    ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
  },
});

const drain = async (result: ScriptedResponsesTurn): Promise<OpenAIResponsesStreamEventEx[]> => {
  if (result.kind !== 'stream') throw new Error(`expected events, got ${result.kind}`);
  const out: OpenAIResponsesStreamEventEx[] = [];
  for await (const f of result.events) if (f.type === 'event') out.push(f.event);
  return out;
};

beforeEach(() => {
  repo = new InMemoryRepo();
  initRepo(repo);
  initImageProcessor(createInMemoryImageProcessor());
  stub.generationsCalls = [];
  stub.editsRequests = [];
  stub.nextGenerations = [];
  stub.nextEdits = [];
  stub.nextResolutionOverride = null;
});

test('generates an image end-to-end and emits the native lifecycle', async () => {
  stub.nextGenerations = [jsonResponse('R0VO')]; // "GEN"
  const result = await shim(makeCtx([{ type: 'message', role: 'user', content: 'draw a cat' }], 'auto', {
    size: '1024x1024',
    quality: 'low',
  }), scriptedRun([
    callTurn(0, 'call_1', 'a cat'),
    messageTurn('here it is'),
  ]));
  const events = await drain(result);

  assertEquals(stub.generationsCalls.length, 1);
  assertEquals(stub.generationsCalls[0], { model: 'gpt-image-2', prompt: 'a cat', n: 1, size: '1024x1024', quality: 'low' });
  assertEquals(stub.editsRequests.length, 0);
  const igcDone = events.find(e => e.type === 'response.output_item.done' && (e as { item: { type: string } }).item.type === 'image_generation_call');
  assert(igcDone !== undefined);
  const item = (igcDone as { item: { status: string; result: string; action: string } }).item;
  assertEquals(item.status, 'completed');
  assertEquals(item.result, 'R0VO');
  assertEquals(item.action, 'generate');
});

test('relays real partial_image frames when partial_images > 0', async () => {
  stub.nextGenerations = [sseResponse([
    JSON.stringify({ type: 'image_generation.partial_image', partial_image_index: 0, b64_json: 'UDA=' }),
    JSON.stringify({ type: 'image_generation.partial_image', partial_image_index: 1, b64_json: 'UDE=' }),
    JSON.stringify({ type: 'image_generation.completed', b64_json: 'RklO' }),
  ])];
  const result = await shim(makeCtx([{ type: 'message', role: 'user', content: 'draw a cat' }], 'auto', { partial_images: 2 }), scriptedRun([
    callTurn(0, 'call_1', 'a cat'),
    messageTurn('done'),
  ]));
  const events = await drain(result);

  assertEquals(stub.generationsCalls[0], { model: 'gpt-image-2', prompt: 'a cat', n: 1, stream: true, partial_images: 2 });
  const partials = events.filter(e => e.type === 'response.image_generation_call.partial_image');
  assertEquals(partials.length, 2);
  assertEquals((partials[0] as { partial_image_b64: string }).partial_image_b64, 'UDA=');
  assertEquals((partials[1] as { partial_image_index: number }).partial_image_index, 1);
  const igcDone = events.find(e => e.type === 'response.output_item.done' && (e as { item: { type: string } }).item.type === 'image_generation_call');
  assertEquals(((igcDone as { item: { result: string } }).item).result, 'RklO');
});

test('an image generated in turn 1 is re-collected as an edit source in turn 2', async () => {
  // Turn 1 generates "AAAA"; the shim feeds it back as an input_image. Turn 2's
  // call must therefore resolve to an EDIT whose image[] part carries those
  // exact bytes — proving the dispatcher re-collects the live input rather than
  // a frozen registration-time snapshot.
  stub.nextGenerations = [jsonResponse('QUFBQQ==')]; // "AAAA"
  stub.nextEdits = [jsonResponse('QkJCQg==')]; // "BBBB"
  const result = await shim(makeCtx([{ type: 'message', role: 'user', content: 'draw then border it' }]), scriptedRun([
    callTurn(0, 'call_1', 'a cat'),
    callTurn(0, 'call_2', 'add a black border'),
    messageTurn('done'),
  ]));
  await drain(result);

  assertEquals(stub.generationsCalls.length, 1);
  assertEquals(stub.editsRequests.length, 1);
  const request = stub.editsRequests[0];
  assertEquals(request.images.length, 1);
  const image = request.images[0];
  const bytes = await image.text();
  assertEquals(bytes, 'AAAA');
});

test('a prefetched remote edit source remains visible to orchestration and is reused by the edits backend', async () => {
  const fetched: string[] = [];
  initExternalResourceFetcher(url => {
    fetched.push(url.href);
    return Promise.resolve(remotePngResponse());
  });
  stub.nextEdits = [jsonResponse('RURJVA==')];
  const invocation = makeCtx([{
    type: 'message',
    role: 'user',
    content: [{ type: 'input_image', image_url: 'https://example.com/source.png', detail: 'auto' }],
  }], 'edit');
  const baseRun = scriptedRun([
    callTurn(0, 'call_1', 'edit the image'),
    messageTurn('done'),
  ]);
  let orchestratorImageUrl: string | undefined;
  const run = async () => {
    if (orchestratorImageUrl === undefined) {
      const item = invocation.payload.input[0];
      if (item?.type === 'message' && Array.isArray(item.content)) {
        const image = item.content.find(block => block.type === 'input_image');
        if (image?.type === 'input_image') orchestratorImageUrl = image.image_url ?? undefined;
      }
    }
    return await baseRun();
  };

  await drain(await shim(invocation, run));

  assertEquals(fetched, ['https://example.com/source.png']);
  assertEquals(orchestratorImageUrl, 'https://example.com/source.png');
  assertEquals(stub.editsRequests.length, 1);
  const request = stub.editsRequests[0];
  const image = request.images[0];
  assertEquals(new Uint8Array(await image.arrayBuffer()), Uint8Array.from(atob(REMOTE_PNG_B64), c => c.charCodeAt(0)));
});

test('mask-only GIF edit transcodes one shared image and mask to WebP', async () => {
  let processorCalls = 0;
  initImageProcessor({
    compressToWebp: () => {
      processorCalls += 1;
      return Promise.resolve(new TextEncoder().encode('WEBP'));
    },
  });
  const gif = 'R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
  stub.nextEdits = [jsonResponse('RURJVA==')];
  const result = await shim(makeCtx([], 'edit', {
    input_image_mask: { image_url: `data:image/gif;base64,${gif}` },
  }), scriptedRun([
    callTurn(0, 'call_1', 'edit from the mask'),
    messageTurn('done'),
  ]));
  await drain(result);

  assertEquals(processorCalls, 1);
  assertEquals(stub.editsRequests.length, 1);
  const request = stub.editsRequests[0];
  const image = request.images[0];
  const mask = request.mask;
  assert(mask !== null);
  assertEquals(image.type, 'image/webp');
  assertEquals(mask.type, 'image/webp');
  assertEquals(await image.text(), 'WEBP');
  assertEquals(await mask.text(), 'WEBP');
});

test('image transcoding failure propagates from the hosted tool stream', async () => {
  initImageProcessor({
    compressToWebp: () => Promise.reject(new Error('codec down')),
  });
  const gif = 'R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
  const result = await shim(makeCtx([{
    type: 'message', role: 'user',
    content: [{ type: 'input_image', image_url: `data:image/gif;base64,${gif}`, detail: 'auto' }],
  }], 'edit'), scriptedRun([
    callTurn(0, 'call_1', 'edit the image'),
    messageTurn('done'),
  ]));
  await expect(drain(result)).rejects.toThrow('codec down');
  assertEquals(stub.editsRequests.length, 0);
});

test('retries on 429 and surfaces the eventual success', async () => {
  // Two 429s then success; the orchestrator should see one completed image_generation_call.
  stub.nextGenerations = [
    rateLimitResponse(1),
    rateLimitResponse(1),
    jsonResponse('T0s='),
  ];
  const result = await shim(makeCtx([{ type: 'message', role: 'user', content: 'draw' }]), scriptedRun([
    callTurn(0, 'call_1', 'a cat'),
    messageTurn('done'),
  ]));
  const events = await drain(result);

  assertEquals(stub.generationsCalls.length, 3);
  const igcDone = events.find(e => e.type === 'response.output_item.done' && (e as { item: { type: string } }).item.type === 'image_generation_call');
  assert(igcDone !== undefined);
  const item = (igcDone as { item: { status: string; result: string } }).item;
  assertEquals(item.status, 'completed');
  assertEquals(item.result, 'T0s=');
});

// resolveImageCandidate failure branches: each variant is normalized into
// a terminal `image_generation_call` item with `status: 'failed'` and a
// specific error.code so the orchestrator can distinguish unknown-model
// from existing-but-unsupported.

test('resolveImageCandidate renders model_not_found when no upstream knows the model id', async () => {
  stub.nextResolutionOverride = { candidates: [], sawModel: false };
  const result = await shim(makeCtx([{ type: 'message', role: 'user', content: 'draw' }]), scriptedRun([
    callTurn(0, 'call_1', 'a cat'),
    messageTurn('sorry'),
  ]));
  const events = await drain(result);

  // Backend never reached: resolution fails before the upstream call.
  assertEquals(stub.generationsCalls.length, 0);
  const igcDone = events.find(e => e.type === 'response.output_item.done' && (e as { item: { type: string } }).item.type === 'image_generation_call');
  assert(igcDone !== undefined);
  const item = (igcDone as { item: { status: string; error: { code: string; message: string } } }).item;
  assertEquals(item.status, 'failed');
  assertEquals(item.error.code, 'model_not_found');
});

test('resolveImageCandidate renders model_not_supported when image-kind candidates exist but none expose the openaiImagesGenerations endpoint', async () => {
  // The resolver produced an image-kind candidate but its `endpoints` does
  // not include the per-endpoint key the request needs (openaiImagesGenerations).
  stub.nextResolutionOverride = {
    candidates: [imageCandidate({ openaiImagesEdits: {} })],
    sawModel: true,
  };
  const result = await shim(makeCtx([{ type: 'message', role: 'user', content: 'draw' }]), scriptedRun([
    callTurn(0, 'call_1', 'a cat'),
    messageTurn('sorry'),
  ]));
  const events = await drain(result);

  assertEquals(stub.generationsCalls.length, 0);
  const igcDone = events.find(e => e.type === 'response.output_item.done' && (e as { item: { type: string } }).item.type === 'image_generation_call');
  assert(igcDone !== undefined);
  const item = (igcDone as { item: { status: string; error: { code: string; message: string } } }).item;
  assertEquals(item.status, 'failed');
  assertEquals(item.error.code, 'model_not_supported');
});

test('an image sub-call records its own perf row attributed to the image backend, leaving the outer attempt untouched', async () => {
  stub.nextGenerations = [jsonResponse('R0VO')];
  const result = await shim(makeCtx([{ type: 'message', role: 'user', content: 'draw a cat' }]), scriptedRun([
    callTurn(0, 'call_1', 'a cat'),
    messageTurn('here it is'),
  ]));
  await drain(result);

  const perfRows = await repo.performance.listAll();
  const imageRows = perfRows.filter(r => r.operation === 'image_generation');
  assertEquals(imageRows.length, 1);
  assertEquals(imageRows[0].upstream, 'u');
  assertEquals(imageRows[0].keyId, 'key_test');
  assertEquals(imageRows[0].model, 'gpt-image-2');
  assertEquals(perfRows.length, 1);
});
