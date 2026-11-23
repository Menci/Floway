import { beforeEach, test } from 'vitest';

import { createServerToolShim } from '../../../../../../src/data-plane/chat/openai-responses/stages/server-tool-shim.ts';
import { imageGenerationServerTool } from '../../../../../../src/data-plane/chat/openai-responses/stages/server-tools/image-generation.ts';
import type { GatewayServices, RouteCandidate } from '../../../../../../src/data-plane/pipeline/services.ts';
import { UpstreamTransportError } from '../../../../../../src/dial/transport-error.ts';
import { upstream } from '../../fixture.ts';
import { driveResponsesStage, type Frame } from '../drive.ts';
import { Bytes, compose, defineEnding } from '@floway-dev/pipeline';
import { createInMemoryImageProcessor, initExternalResourceFetcher, initImageProcessor } from '@floway-dev/platform';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIImagesGenerationsPayload } from '@floway-dev/protocols/openai-images';
import type { CanonicalOpenAIResponsesInputItem, CanonicalOpenAIResponsesPayload, OpenAIResponsesResultEx, OpenAIResponsesStreamEventEx, OpenAIResponsesToolChoice } from '@floway-dev/protocols/openai-responses';
import type { OpenAIImagesEditsRequest, ProviderHttpOutput, ProviderInput, ProviderServices } from '@floway-dev/provider';
import { assert, assertEquals, assertStringIncludes, stubProvider, stubProviderModel } from '@floway-dev/test-utils';

interface Invocation { payload: CanonicalOpenAIResponsesPayload }

type GenerationPayload = Omit<OpenAIImagesGenerationsPayload, 'model'>;
type Resolution = Awaited<ReturnType<GatewayServices['providers']['enumerate']>>;
const stub = {
  generationsCalls: [] as GenerationPayload[],
  editsRequests: [] as OpenAIImagesEditsRequest[],
  nextGenerations: [] as (Response | Error)[],
  nextEdits: [] as (Response | Error)[],
  performance: [] as Parameters<GatewayServices['performanceStore']['record']>[0][],
  nextResolutionOverride: undefined as Resolution | undefined,
};

const backendPipeline = <Payload>(name: string, respond: (payload: Payload) => Response | Error | undefined) =>
  compose<ProviderInput<Payload>, ProviderHttpOutput, ProviderServices>(name, {
    stages: [],
    ending: defineEnding<ProviderInput<Payload>, ProviderHttpOutput>({
      name: 'stubImageProvider',
      request: { needs: ['provider.model', 'request.headers', 'request.payload'] },
      return: { provides: ['response.http', 'response.modelKey'] },
      execute: async facts => {
        const response = respond(facts['request.payload']);
        if (response === undefined) throw new Error('Test did not enqueue an image provider response');
        if (response instanceof Error) throw response;
        return {
          'response.modelKey': 'gpt-image-2',
          'response.http': {
            status: response.status, statusText: response.statusText, headers: [...response.headers],
            body: Bytes.adopt(new Uint8Array(await response.arrayBuffer())), timing: { startedAt: 0, headersAt: 1 },
          },
        };
      },
    }),
  });
const base = upstream('image-backend', {
  openaiImagesGenerations: backendPipeline<GenerationPayload>('test.image-generation', payload => {
    stub.generationsCalls.push(payload);
    return stub.nextGenerations.shift();
  }),
  openaiImagesEdits: backendPipeline<OpenAIImagesEditsRequest>('test.image-edit', payload => {
    stub.editsRequests.push(payload);
    return stub.nextEdits.shift();
  }),
}, [], 'image');
const imageProvider = { ...base.provider, instance: stubProvider() };
const endpoints = { openaiImagesGenerations: {}, openaiImagesEdits: {} };
const imageCandidate: RouteCandidate = {
  ...base.candidate, modelId: 'gpt-image-2', upstreamModelId: 'gpt-image-2', endpoints,
  providerModel: { ...stubProviderModel({ kind: 'image', id: 'gpt-image-2', upstreamModelId: 'gpt-image-2', endpoints }), enabledFlags: [] },
};
const imageShim = createServerToolShim([imageGenerationServerTool]);

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

const scriptedRun = (turns: Frame[][]) => {
  let index = 0;
  return async function* (): AsyncGenerator<Frame> {
    const turn = turns[index++];
    if (turn === undefined) throw new Error(`Unexpected Responses call ${index}`);
    yield* turn;
  };
};

const makePayload = (
  input: CanonicalOpenAIResponsesInputItem[], action: 'generate' | 'edit' | 'auto' = 'auto',
  extraTool: Record<string, unknown> = {}, toolChoice?: OpenAIResponsesToolChoice,
): Invocation => ({
  payload: {
    model: 'orchestrator', input,
    tools: [{ type: 'image_generation', action, ...extraTool }],
    ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
  },
});

const shim = async (invocation: Invocation, respond: () => AsyncIterable<Frame> | Promise<AsyncIterable<Frame>>) => {
  return await driveResponsesStage(imageShim, invocation.payload, {
    enabledFlags: new Set(['openai-responses-image-generation-shim']),
    services: {
      providers: {
        resolve(id) {
          if (id !== imageProvider.upstreamId) throw new Error(`Unexpected image upstream ${id}`);
          return imageProvider;
        },
        enumerate: async () => {
          const override = stub.nextResolutionOverride;
          stub.nextResolutionOverride = undefined;
          return override ?? { candidates: [imageCandidate], sawModel: true, failedUpstreams: [] };
        },
      },
      performanceStore: { record: async row => { stub.performance.push(row); } },
    },
    upstream(payload) {
      invocation.payload = payload;
      return respond();
    },
  });
};

const drain = async (reply: Awaited<ReturnType<typeof shim>>, successfulRun = true): Promise<OpenAIResponsesStreamEventEx[]> => {
  const events = reply.result['response.openaiResponses'];
  assert(events !== undefined);
  const frames: OpenAIResponsesStreamEventEx[] = [];
  for await (const frame of events) if (frame.type === 'event') frames.push(frame.event);
  assertEquals((await reply.done).ok, successfulRun);
  return frames;
};

beforeEach(() => {
  initImageProcessor(createInMemoryImageProcessor());
  stub.generationsCalls = [];
  stub.editsRequests = [];
  stub.nextGenerations = [];
  stub.nextEdits = [];
  stub.performance = [];
  stub.nextResolutionOverride = undefined;
});

test('generates an image end-to-end and emits the native lifecycle', async () => {
  stub.nextGenerations = [jsonResponse('R0VO')]; // "GEN"
  const result = await shim(makePayload([{ type: 'message', role: 'user', content: 'draw a cat' }], 'auto', {
    size: '1024x1024',
    quality: 'low',
  }), scriptedRun([
    callTurn(0, 'call_1', 'a cat'),
    messageTurn('here it is'),
  ]));
  const events = await drain(result);

  assertEquals(stub.generationsCalls.length, 1);
  assertEquals(stub.generationsCalls[0], { prompt: 'a cat', n: 1, size: '1024x1024', quality: 'low' });
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
  const result = await shim(makePayload([{ type: 'message', role: 'user', content: 'draw a cat' }], 'auto', { partial_images: 2 }), scriptedRun([
    callTurn(0, 'call_1', 'a cat'),
    messageTurn('done'),
  ]));
  const events = await drain(result);

  assertEquals(stub.generationsCalls[0], { prompt: 'a cat', n: 1, stream: true, partial_images: 2 });
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
  const result = await shim(makePayload([{ type: 'message', role: 'user', content: 'draw then border it' }]), scriptedRun([
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
  assert(image.type === 'upload');
  const bytes = image.bytes.utf8();
  assertEquals(bytes, 'AAAA');
});

test('a prefetched remote edit source remains visible to orchestration and is reused by the edits backend', async () => {
  const fetched: string[] = [];
  initExternalResourceFetcher(url => {
    fetched.push(url.href);
    return Promise.resolve(remotePngResponse());
  });
  stub.nextEdits = [jsonResponse('RURJVA==')];
  const invocation = makePayload([{
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
    return baseRun();
  };

  await drain(await shim(invocation, run));

  assertEquals(fetched, ['https://example.com/source.png']);
  assertEquals(orchestratorImageUrl, 'https://example.com/source.png');
  assertEquals(stub.editsRequests.length, 1);
  const request = stub.editsRequests[0];
  const image = request.images[0];
  assert(image.type === 'upload');
  assertEquals(image.bytes.toUint8Array(), Uint8Array.from(atob(REMOTE_PNG_B64), c => c.charCodeAt(0)));
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
  const result = await shim(makePayload([], 'edit', {
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
  assert(image.type === 'upload');
  assert(mask?.type === 'upload');
  assertEquals(image.contentType, 'image/webp');
  assertEquals(mask.contentType, 'image/webp');
  assertEquals(image.bytes.utf8(), 'WEBP');
  assertEquals(mask.bytes.utf8(), 'WEBP');
});

test('image transcoding failure becomes a terminal image tool failure', async () => {
  initImageProcessor({
    compressToWebp: () => Promise.reject(new Error('codec down')),
  });
  const gif = 'R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
  const result = await shim(makePayload([{
    type: 'message', role: 'user',
    content: [{ type: 'input_image', image_url: `data:image/gif;base64,${gif}`, detail: 'auto' }],
  }], 'edit'), scriptedRun([
    callTurn(0, 'call_1', 'edit the image'),
    messageTurn('done'),
  ]));
  const events = await drain(result);

  assertEquals(stub.editsRequests.length, 0);
  const done = events.find(event => event.type === 'response.output_item.done'
    && (event as { item: { type: string } }).item.type === 'image_generation_call');
  assert(done !== undefined);
  const item = (done as { item: { status: string; error: { code: string; message: string } } }).item;
  assertEquals(item.status, 'failed');
  assertEquals(item.error.code, 'server_error');
  assertStringIncludes(item.error.message, 'codec down');
});

test('retries on 429 and surfaces the eventual success', async () => {
  // Two 429s then success; the orchestrator should see one completed image_generation_call.
  stub.nextGenerations = [
    rateLimitResponse(1),
    rateLimitResponse(1),
    jsonResponse('T0s='),
  ];
  const result = await shim(makePayload([{ type: 'message', role: 'user', content: 'draw' }]), scriptedRun([
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
  stub.nextResolutionOverride = { candidates: [], sawModel: false, failedUpstreams: [] };
  const result = await shim(makePayload([{ type: 'message', role: 'user', content: 'draw' }]), scriptedRun([
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
    candidates: [{ ...imageCandidate, endpoints: { openaiImagesEdits: {} } }],
    sawModel: true,
    failedUpstreams: [],
  };
  const result = await shim(makePayload([{ type: 'message', role: 'user', content: 'draw' }]), scriptedRun([
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

test('an image sub-run records an independent performance row for the image backend', async () => {
  stub.nextGenerations = [jsonResponse('R0VO')];
  const result = await shim(makePayload([{ type: 'message', role: 'user', content: 'draw a cat' }]), scriptedRun([
    callTurn(0, 'call_1', 'a cat'),
    messageTurn('here it is'),
  ]));
  await drain(result);

  assertEquals(stub.performance.length, 1);
  const row = stub.performance[0];
  assert(row.kind === 'neutral');
  assertEquals(row.dimensions.operation, 'image_generation');
  assertEquals(row.dimensions.upstream, 'image-backend');
  assertEquals(row.dimensions.keyId, 'test-key');
  assertEquals(row.dimensions.model, 'gpt-image-2');
});

test('image provider transport failure preserves the tool error and its performance row', async () => {
  stub.nextGenerations = [new UpstreamTransportError(new TypeError('image connection lost'))];
  const result = await shim(makePayload([{ type: 'message', role: 'user', content: 'draw a cat' }]), scriptedRun([
    callTurn(0, 'call_1', 'a cat'),
    messageTurn('replacement instructions'),
  ]));
  const events = await drain(result, false);
  const image = events.find(event => event.type === 'response.output_item.done' && event.item.type === 'image_generation_call');
  assert(image?.type === 'response.output_item.done' && image.item.type === 'image_generation_call');
  assertEquals(image.item.status, 'failed');
  assertStringIncludes(JSON.stringify(image.item), 'image connection lost');
  assertEquals(stub.performance.length, 1);
  assertEquals(stub.performance[0].kind, 'zero-output-error');
});
