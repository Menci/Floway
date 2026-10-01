import { afterEach, expect, test, vi } from 'vitest';

import * as imageRequest from '../../../../../src/data-plane/chat/openai-responses/hosted-tools/image-sub-request/request.ts';
import type { ImageGenerationRequest } from '../../../../../src/data-plane/chat/openai-responses/hosted-tools/image-sub-request/request.ts';
import * as imageResult from '../../../../../src/data-plane/chat/openai-responses/hosted-tools/image-sub-request/result.ts';
import { runImageGenerationSubRequest } from '../../../../../src/data-plane/chat/openai-responses/hosted-tools/image-sub-request.ts';
import * as resolution from '../../../../../src/data-plane/providers/resolution.ts';
import { initDumpBroker, initDumpStore } from '../../../../../src/dump/registry.ts';
import { openRunDump } from '../../../../../src/dump/run-sink.ts';
import { initRepo } from '../../../../../src/repo/index.ts';
import type { ApiKey } from '../../../../../src/repo/types.ts';
import { eventsOf, installDumpStubs } from '../../../../dump/test-fixtures.ts';
import { InMemoryRepo } from '../../../../repo/memory.ts';
import { flushBackground, trackBackground } from '../../../../test-utils/background-tracker.ts';
import { mockGatewayCtx } from '../../../../test-utils/gateway-ctx.ts';
import { stubProviderPipeline } from '../../../../test-utils/provider-pipeline.ts';
import { createRunReader, getFailureFacts, type DumpEvent } from '@floway-dev/pipeline';
import { stubModelCandidate } from '@floway-dev/test-utils';

const apiKey: ApiKey = { id: 'image-key', userId: 1, name: 'Image key', key: 'floway-image-key', serverSecret: '00'.repeat(32), createdAt: '2026-01-01T00:00:00Z', upstreamIds: null, deletedAt: null, dumpRetentionSeconds: 3600, openaiResponsesRetentionSeconds: 0 };
afterEach(() => { vi.restoreAllMocks(); });

for (const action of ['generate', 'edit'] as const) for (const consume of [false, true]) {
  test(`a recorded hosted image ${action} carries source facts through the full model chain when ${consume ? 'consumed' : 'returned unread'}`, async () => {
    const repo = new InMemoryRepo();
    initRepo(repo);
    const dumps = installDumpStubs(initDumpStore, initDumpBroker);
    const dump = openRunDump(apiKey, { method: 'POST', path: '/v1/responses', body: { bytes: new Uint8Array(), streamError: null } }, trackBackground, true, { upstreamCallStartedAt: null, firstOutputTokenAt: null });
    const parent = mockGatewayCtx({ dump, backgroundScheduler: trackBackground });
    const plainCandidate = stubModelCandidate({ model: { id: 'image-model', kind: 'image', endpoints: { openaiImagesGenerations: {}, openaiImagesEdits: {} } } });
    const prefix = action === 'edit' ? 'image_edit' : 'image_generation';
    const response = () => new Response([
      { type: `${prefix}.partial_image`, partial_image_index: 0, b64_json: 'preview' },
      { type: `${prefix}.completed`, b64_json: 'pixels', usage: { input_tokens: 7, output_tokens: 3 } },
    ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
    const generate = vi.fn(async () => ({ response: response(), modelKey: 'backend-image' }));
    const edit = vi.fn(async () => ({ response: response(), modelKey: 'backend-image' }));
    const candidate = {
      ...plainCandidate, provider: {
        ...plainCandidate.provider, pipelines: {
          openaiImagesGenerations: stubProviderPipeline('openaiImagesGenerations', generate),
          openaiImagesEdits: stubProviderPipeline('openaiImagesEdits', edit),
        },
      },
    };
    vi.spyOn(resolution, 'enumerateModelCandidates').mockResolvedValue({ candidates: [candidate], sawModel: true, failedUpstreams: [] });
    const request: ImageGenerationRequest = {
      prompt: 'draw a tree', action, config: { model: 'image-model', action, quality: 'high', partial_images: 1 },
      sources: action === 'edit' ? [{ bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/png' }] : [],
    };
    const run = await runImageGenerationSubRequest(parent, request);
    if (consume) {
      expect(await run.lifecycle.next()).toMatchObject({ done: false, value: { type: 'response.image_generation_call.partial_image', partial_image_index: 0, partial_image_b64: 'preview' } });
      expect(await run.lifecycle.next()).toMatchObject({ done: true, value: { item: { type: 'image_generation_call', status: 'completed', action, revised_prompt: 'draw a tree', result: 'pixels' }, endEvents: [{ type: 'response.image_generation_call.completed' }] } });
    } else {
      await run.lifecycle.return(undefined as never);
    }
    await run.drain();
    dump?.finalize(200, 0);
    await flushBackground();
    expect(generate).toHaveBeenCalledTimes(action === 'generate' ? 1 : 0);
    expect(edit).toHaveBeenCalledTimes(action === 'edit' ? 1 : 0);
    expect(parent.attempt.telemetry).toBeUndefined();
    expect(dumps.stored).toHaveLength(2);
    expect(dumps.stored.filter(item => item.record.meta.path === '/v1/responses')).toHaveLength(1);
    const record = dumps.stored.find(item => item.record.meta.path !== '/v1/responses')!.record;
    expect(record.meta.path).toBe(action === 'edit' ? '/images/edits' : '/images/generations');
    const read = createRunReader();
    const decoded = eventsOf(record).map(event => read(event as unknown as DumpEvent));
    expect(decoded.find(event => event?.facts && 'request.imageGeneration.canonical' in event.facts)?.facts?.['request.imageGeneration.canonical']).toEqual({ ...request, sources: action === 'edit' ? [{ bytes: { bytes: 'AQID' }, mimeType: 'image/png' }] : [] });
    const prepared = decoded.find(event => event?.facts && 'request.openaiImages.canonical' in event.facts)?.facts?.['request.openaiImages.canonical'];
    expect(prepared).toMatchObject({ operation: action === 'edit' ? 'edits' : 'generations', parameters: { prompt: 'draw a tree', n: 1, quality: 'high', stream: true, partial_images: 1 } });
    if (action === 'edit') expect(prepared).toMatchObject({ images: [{ kind: 'file', file: { fileName: 'image_0.png', mediaType: 'image/png', bytes: { bytes: 'AQID' } } }] });
    const entered = eventsOf(record).filter(event => event.type === 'stage.entered').map(event => event.name);
    expect(entered).toEqual(['writeSettlement', 'emitHostedImageGeneration', 'prepareHostedImageGeneration', 'resolveCandidates', 'failover', 'retryRateLimitedImages', 'callOpenAIImagesUpstream', 'stubHttp']);
    const frames = decoded.flatMap(event => event?.frames ?? []);
    if (consume) expect(frames).toContainEqual({ type: 'event', event: { item: { type: 'image_generation_call', status: 'completed', action, result: 'pixels', revised_prompt: 'draw a tree' }, endEvents: [{ type: 'response.image_generation_call.completed' }] } });
    else expect(frames).toEqual([]);
    const observations = await repo.usage.listAll();
    expect(observations).toMatchObject([{ model: 'image-model', modelKey: 'backend-image', requests: 1 }]);
    expect(await repo.performance.listAll()).toMatchObject([{ requests: 1, neutral: 1, errorsNoOutput: 0, errorsWithOutput: 0 }]);
    expect(record.meta.status).toBe(200);
    expect(record.meta.error).toBeNull();
  });
}

test('hosted image preparation preserves an internal TypeError and records the failed child boundary', async () => {
  initRepo(new InMemoryRepo());
  const dumps = installDumpStubs(initDumpStore, initDumpBroker);
  const dump = openRunDump(apiKey, { method: 'POST', path: '/v1/responses', body: { bytes: new Uint8Array(), streamError: null } }, trackBackground, true, { upstreamCallStartedAt: null, firstOutputTokenAt: null });
  const parent = mockGatewayCtx({ dump, backgroundScheduler: trackBackground });
  const fault = new TypeError('image preparation state is invalid');
  vi.spyOn(imageRequest, 'prepareImageRequest').mockRejectedValue(fault);
  const request: ImageGenerationRequest = { prompt: 'tree', action: 'generate', config: { model: 'image-model', action: 'generate' }, sources: [] };
  await expect(runImageGenerationSubRequest(parent, request)).rejects.toBe(fault);
  expect(getFailureFacts(fault)?.['request.imageGeneration.canonical']).toBe(request);
  dump?.finalize(200, 0);
  await flushBackground();
  expect(dumps.stored).toHaveLength(2);
  const record = dumps.stored.find(item => item.record.meta.path === '/images/generations')!.record;
  expect(record.meta.status).toBe(500);
  expect(record.meta.error).toEqual({ kind: 'failed', reason: fault.message });
  const events = eventsOf(record);
  const entered = events.find(event => event.type === 'stage.entered' && event.name === 'prepareHostedImageGeneration');
  expect(entered).toBeDefined();
  expect(events).toContainEqual(expect.objectContaining({ type: 'stage.failed', stageId: entered!.stageId }));
});

const openGeneration = async (stream: boolean, signal?: AbortSignal) => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const dumps = installDumpStubs(initDumpStore, initDumpBroker);
  const dump = openRunDump(apiKey, { method: 'POST', path: '/v1/responses', body: { bytes: new Uint8Array(), streamError: null } }, trackBackground, true, { upstreamCallStartedAt: null, firstOutputTokenAt: null });
  const parent = mockGatewayCtx({ dump, backgroundScheduler: trackBackground, ...(signal === undefined ? {} : { abortSignal: signal }) });
  const body = stream ? new Response([
    { type: 'image_generation.partial_image', partial_image_index: 0, b64_json: 'preview' },
    { type: 'image_generation.completed', b64_json: 'pixels', usage: { input_tokens: 7, output_tokens: 3 } },
  ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
    : Response.json({ data: [{ b64_json: 'pixels' }], usage: { input_tokens: 7, output_tokens: 3 } });
  const dial = vi.fn(async () => ({ response: body, modelKey: 'backend-image' }));
  const plain = stubModelCandidate({ model: { id: 'image-model', kind: 'image', endpoints: { openaiImagesGenerations: {} } } });
  const candidate = { ...plain, provider: { ...plain.provider, pipelines: { openaiImagesGenerations: stubProviderPipeline('openaiImagesGenerations', dial) } } };
  vi.spyOn(resolution, 'enumerateModelCandidates').mockResolvedValue({ candidates: [candidate], sawModel: true, failedUpstreams: [] });
  const call = await runImageGenerationSubRequest(parent, { prompt: 'tree', action: 'generate', config: { model: 'image-model', action: 'generate', ...(stream ? { partial_images: 1 } : {}) }, sources: [] });
  return { repo, dumps, dump, call, dial };
};

for (const stream of [false, true]) test(`a ${stream ? 'streamed' : 'JSON'} child emission exception keeps measured usage and fails through drain`, async () => {
  const { repo, dumps, dump, call, dial } = await openGeneration(stream);
  const fault = new TypeError('image lifecycle formatter broke', { cause: new Error('invalid rendering state') });
  vi.spyOn(imageResult, 'imageTerminal').mockImplementation(() => { throw fault; });
  if (stream) expect(await call.lifecycle.next()).toMatchObject({ done: false });
  await expect(call.lifecycle.next()).rejects.toBe(fault);
  await expect(call.drain()).rejects.toBe(fault);
  dump?.finalize(200, 0);
  await flushBackground();
  expect(dial).toHaveBeenCalledOnce();
  expect(await repo.usage.listAll()).toMatchObject([{
    requests: 1, metrics: [
      { metric: 'input_tokens', quantity: '7' }, { metric: 'output_tokens', quantity: '3' },
    ],
  }]);
  expect(await repo.performance.listAll()).toMatchObject([{ requests: 1, neutral: 0, errorsNoOutput: 1 }]);
  const record = dumps.stored.find(item => item.record.meta.path === '/images/generations')!.record;
  expect(record.meta).toMatchObject({ status: 500, inputTokens: 7, outputTokens: 3, error: { kind: 'failed', reason: fault.message } });
  const read = createRunReader();
  const logs: unknown[] = [];
  for (const item of eventsOf(record)) {
    const event = item as unknown as DumpEvent;
    read(event);
    if (event.type === 'stage.log' && event.fields !== undefined) logs.push(read.decode(event.fields));
  }
  expect(logs).toContainEqual(expect.objectContaining({ error: expect.objectContaining({ error: expect.objectContaining({ message: fault.message, cause: expect.objectContaining({ error: expect.objectContaining({ message: 'invalid rendering state' }) }) }) }) }));
});

test('an actual parent abort keeps the source failure verdict and original streamed HTTP status', async () => {
  const controller = new AbortController();
  const { repo, dumps, dump, call } = await openGeneration(true, controller.signal);
  controller.abort(new Error('parent canceled'));
  expect(controller.signal.aborted).toBe(true);
  await call.lifecycle.return(undefined as never);
  await expect(call.drain()).rejects.toThrow('OpenAI Images stream ended without a completed event.');
  dump?.finalize(200, 0);
  await flushBackground();
  expect(await repo.usage.listAll()).toMatchObject([{ requests: 1, metrics: [] }]);
  expect(await repo.performance.listAll()).toMatchObject([{ requests: 1, errorsNoOutput: 1, neutral: 0 }]);
  const record = dumps.stored.find(item => item.record.meta.path === '/images/generations')!.record;
  expect(record.meta).toMatchObject({ status: 200, error: { kind: 'failed', reason: 'OpenAI Images stream ended without a completed event.' } });
});
