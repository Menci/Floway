import { afterEach, expect, test, vi } from 'vitest';

import type { ImageGenerationRequest } from '../../../../../src/data-plane/chat/openai-responses/hosted-tools/image-sub-request/request.ts';
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
import { createRunReader, type DumpEvent } from '@floway-dev/pipeline';
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
    const candidate = stubModelCandidate({ model: { id: 'image-model', kind: 'image', endpoints: { openaiImagesGenerations: {}, openaiImagesEdits: {} } } });
    const prefix = action === 'edit' ? 'image_edit' : 'image_generation';
    const response = () => new Response([
      { type: `${prefix}.partial_image`, partial_image_index: 0, b64_json: 'preview' },
      { type: `${prefix}.completed`, b64_json: 'pixels', usage: { input_tokens: 7, output_tokens: 3 } },
    ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
    const generate = vi.spyOn(candidate.provider.instance, 'callOpenAIImagesGenerations').mockImplementation(async () => ({ response: response(), modelKey: 'backend-image' }));
    const edit = vi.spyOn(candidate.provider.instance, 'callOpenAIImagesEdits').mockImplementation(async () => ({ response: response(), modelKey: 'backend-image' }));
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
    await flushBackground();
    expect(generate).toHaveBeenCalledTimes(action === 'generate' ? 1 : 0);
    expect(edit).toHaveBeenCalledTimes(action === 'edit' ? 1 : 0);
    expect(parent.attempt.telemetry).toBeUndefined();
    expect(dumps.stored).toHaveLength(1);
    const record = dumps.stored[0]!.record;
    expect(record.meta.path).toBe(action === 'edit' ? '/images/edits' : '/images/generations');
    const read = createRunReader();
    const decoded = eventsOf(record).map(event => read(event as unknown as DumpEvent));
    expect(decoded.find(event => event?.facts && 'request.imageGeneration.canonical' in event.facts)?.facts?.['request.imageGeneration.canonical']).toEqual({ ...request, sources: action === 'edit' ? [{ bytes: { bytes: 'AQID' }, mimeType: 'image/png' }] : [] });
    const prepared = decoded.find(event => event?.facts && 'request.openaiImages.canonical' in event.facts)?.facts?.['request.openaiImages.canonical'];
    expect(prepared).toMatchObject({ operation: action === 'edit' ? 'edits' : 'generations', parameters: { prompt: 'draw a tree', n: 1, quality: 'high', stream: true, partial_images: 1 } });
    if (action === 'edit') expect(prepared).toMatchObject({ images: [{ kind: 'file', file: { fileName: 'image_0.png', mediaType: 'image/png', bytes: { bytes: 'AQID' } } }] });
    const entered = eventsOf(record).filter(event => event.type === 'stage.entered').map(event => event.name);
    expect(entered).toEqual(['emitHostedImageGeneration', 'prepareHostedImageGeneration', 'writeSettlement', 'resolveCandidates', 'failover', 'retryRateLimitedImages', 'callOpenAIImagesUpstream']);
    const frames = decoded.flatMap(event => event?.frames ?? []);
    if (consume) expect(frames).toContainEqual({ type: 'event', event: { item: { type: 'image_generation_call', status: 'completed', action, result: 'pixels', revised_prompt: 'draw a tree' }, endEvents: [{ type: 'response.image_generation_call.completed' }] } });
    else expect(frames).toEqual([]);
    const observations = await repo.usage.listAll();
    expect(observations).toMatchObject([{ model: 'image-model', modelKey: 'backend-image', requests: 1 }]);
  });
}
