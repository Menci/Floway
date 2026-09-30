import { expect, test } from 'vitest';

import { runImageGenerationSubRequest } from '../../../../../src/data-plane/chat/openai-responses/hosted-tools/image-sub-request.ts';
import type { HostedToolTerminal } from '../../../../../src/data-plane/chat/openai-responses/hosted-tools/types.ts';
import { initDumpBroker, initDumpStore } from '../../../../../src/dump/registry.ts';
import { openRunDump } from '../../../../../src/dump/run-sink.ts';
import type { ApiKey } from '../../../../../src/repo/types.ts';
import { eventsOf, installDumpStubs } from '../../../../dump/test-fixtures.ts';
import { flushBackground, trackBackground } from '../../../../test-utils/background-tracker.ts';
import { mockGatewayCtx } from '../../../../test-utils/gateway-ctx.ts';
import { createRunReader, type DumpEvent } from '@floway-dev/pipeline';

const apiKey: ApiKey = { id: 'image-key', userId: 1, name: 'Image key', key: 'floway-image-key', serverSecret: '00'.repeat(32), createdAt: '2026-01-01T00:00:00Z', upstreamIds: null, deletedAt: null, dumpRetentionSeconds: 3600, openaiResponsesRetentionSeconds: 0 };

test('a recorded image lifecycle preserves its terminal result and independent run', async () => {
  const dumps = installDumpStubs(initDumpStore, initDumpBroker);
  const dump = openRunDump(apiKey, { method: 'POST', path: '/v1/responses', body: { bytes: new Uint8Array(), streamError: null } }, trackBackground, true, { upstreamCallStartedAt: null, firstOutputTokenAt: null });
  const parent = mockGatewayCtx({ dump, backgroundScheduler: trackBackground });
  const terminal: HostedToolTerminal = { item: { type: 'image_generation_call', id: 'image', status: 'completed', result: 'pixels' }, endEvents: [] };
  const progress = { type: 'response.image_generation_call.in_progress', item_id: 'image' };
  const run = await runImageGenerationSubRequest(parent, 'generate', settle => (async function* () {
    yield progress;
    settle([], false, undefined);
    return terminal;
  })());
  expect(await run.lifecycle.next()).toEqual({ done: false, value: progress });
  const result = await run.lifecycle.next();
  expect(result.done).toBe(true);
  expect(result.value).toBe(terminal);
  await run.drain();
  await flushBackground();
  expect(dumps.stored).toHaveLength(1);
  const record = dumps.stored[0]!.record;
  expect(record.meta.path).toBe('/images/generations');
  const read = createRunReader();
  const decoded = eventsOf(record).map(event => read(event as unknown as DumpEvent));
  expect(decoded.flatMap(event => event?.frames ?? [])).toEqual([{ type: 'event', event: progress }, { type: 'event', event: terminal }]);
  expect(new TextDecoder().decode(record.events)).toContain('request.imageGeneration.action');
  expect(new TextDecoder().decode(record.events)).not.toContain('request.imageGeneration.call');
});
