import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { emitOpenAIResponses } from '../../../../src/data-plane/chat/openai-responses/emit.ts';
import type { Fields } from '../../../../src/data-plane/chat/openai-responses/facts.ts';
import { LayeredOpenAIResponsesStatefulStore, MemoryOpenAIResponsesStatefulBacking } from '../../../../src/data-plane/chat/openai-responses/items/store.ts';
import { meterUsage } from '../../../../src/data-plane/chat/openai-responses/meter.ts';
import { initDumpBroker, initDumpStore } from '../../../../src/dump/registry.ts';
import { openRunDump } from '../../../../src/dump/run-sink.ts';
import { initRepo } from '../../../../src/repo/index.ts';
import type { ApiKey } from '../../../../src/repo/types.ts';
import { installDumpStubs } from '../../../dump/test-fixtures.ts';
import { flushBackground, trackBackground } from '../../../test-utils/background-tracker.ts';
import { mockChatGatewayCtx } from '../../../test-utils/gateway-ctx.ts';
import { compose, createRunReader, defineStage, move, run, type DumpEvent } from '@floway-dev/pipeline';
import type { ProtocolFrame, SseFrame } from '@floway-dev/protocols/common';
import type { ClientOpenAIResponsesStreamEvent, OpenAIResponsesStreamEvent } from '@floway-dev/protocols/openai-responses';
import { testTelemetryModelIdentity } from '@floway-dev/test-utils';

const key: ApiKey = {
  id: 'key_emit', userId: 1, name: 'Emitter key', key: 'emitter-key', serverSecret: '11'.repeat(32),
  createdAt: '2026-01-01T00:00:00.000Z', upstreamIds: null, deletedAt: null,
  dumpRetentionSeconds: 3600, openaiResponsesRetentionSeconds: 0,
};

type Entry = Fields<'ingress.chat.openaiResponses.wantsStream'>;
type Answer = Entry & Fields<'response.chat.openaiResponses' | 'response.usage.billable' | 'response.http.headers'>;
type Exit = Fields<'response.chat.openaiResponses.rendered' | 'response.chat.openaiResponses.streamedUsage'>;

beforeEach(() => {
  initRepo({ upstreams: { getById: async () => null } } as never);
});
afterEach(() => { vi.restoreAllMocks(); });

for (const failureAt of ['before-response', 'upstream-stream', 'snapshot', 'render'] as const) {
  test(`records the exact client protocol failure frames for ${failureAt} failure`, async () => {
    const announced = failureAt !== 'before-response';
    const stubs = installDumpStubs(initDumpStore, initDumpBroker);
    const timing = { upstreamCallStartedAt: 1, firstOutputTokenAt: null };
    const dump = openRunDump(key, {
      method: 'POST', path: '/v1/responses', body: { bytes: new Uint8Array(), streamError: null },
    }, trackBackground, true, timing);
    if (dump === null) throw new Error('retained request did not open its recording');
    const fault = new Error('upstream connection broke', { cause: new Error('socket reset') });
    const backing = new MemoryOpenAIResponsesStatefulBacking();
    const store = failureAt === 'snapshot' ? new LayeredOpenAIResponsesStatefulStore({ apiKeyId: key.id, reads: [backing], writes: [backing] }) : undefined;
    if (store !== undefined) {
      expect(store.writesState).toBe(true);
      vi.spyOn(store, 'commitSnapshot').mockRejectedValue(fault);
    }
    const gateway = mockChatGatewayCtx({ dump, wantsStream: true, backgroundScheduler: trackBackground, attempt: { timing, telemetry: undefined }, ...(store === undefined ? {} : { store }) });
    const upstream = (async function* (): AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEvent>> {
      if (announced) {
        yield {
          type: 'event', event: {
            type: 'response.created', sequence_number: 0,
            response: { id: 'upstream-response', object: 'response', model: 'model', status: 'in_progress', output: [], error: null, incomplete_details: null },
          },
        };
      }
      if (failureAt === 'render') {
        yield { type: 'event', event: { type: 'response.in_progress', response: { id: 'upstream-response', object: 'response', model: 'model', status: 'in_progress', output: [], error: null, incomplete_details: null, impossibleJson: 1n } } };
        return;
      }
      if (failureAt === 'snapshot') {
        yield {
          type: 'event', event: {
            type: 'response.completed', sequence_number: 1,
            response: { id: 'upstream-response', object: 'response', model: 'model', status: 'completed', output: [], error: null, incomplete_details: null, usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } },
          },
        };
        return;
      }
      throw fault;
    })();
    const dial = defineStage<Entry, Answer>({
      name: 'scriptedDial',
      return: { provides: ['response.chat.openaiResponses', 'response.usage.billable', 'response.http.headers'] },
      execute: async facts => move({
        ...facts, 'response.chat.openaiResponses': { kind: 'stream', frames: upstream },
        'response.usage.billable': [{ identity: testTelemetryModelIdentity, quantities: {} }], 'response.http.headers': [],
      }),
    });
    const outcome = await run(compose<Entry, Exit>('clientFailure', [
      emitOpenAIResponses({ model: 'model', input: [], store: false }, 'sse'),
      meterUsage('response.chat.openaiResponses.streamedUsage'), dial,
    ]), move({ 'ingress.chat.openaiResponses.wantsStream': true }), { gateway, dump: dump.sink });
    const wire: SseFrame[] = [];
    for await (const frame of outcome.facts['response.chat.openaiResponses.rendered'] as AsyncIterable<SseFrame>) wire.push(frame);
    expect((await outcome.facts['response.chat.openaiResponses.streamedUsage'])?.failed).toBe(true);
    if (store !== undefined) {
      expect(store.commitSnapshot).toHaveBeenCalledTimes(1);
      expect((await outcome.facts['response.chat.openaiResponses.streamedUsage'])?.billable).toMatchObject([{ quantities: { input_tokens: '10', output_tokens: '5' } }]);
    }
    await outcome.drain();
    dump.finalize(200, 0);
    await flushBackground();

    const read = createRunReader();
    const streams = new Map<number, ProtocolFrame<ClientOpenAIResponsesStreamEvent>[]>();
    let client: number | null = null;
    const record = stubs.stored[0]?.record;
    if (!record) throw new Error('completed request did not persist its recording');
    for (const line of new TextDecoder().decode(record.events).split('\n').filter(Boolean)) {
      const event = JSON.parse(line) as DumpEvent;
      const decoded = read(event);
      if (decoded?.facts && 'response.chat.clientFrames' in decoded.facts) {
        client = (decoded.facts['response.chat.clientFrames'] as { stream: number }).stream;
      }
      if (event.type === 'stream.frame') {
        const frames = streams.get(event.streamId) ?? [];
        frames.push(...decoded?.frames as ProtocolFrame<ClientOpenAIResponsesStreamEvent>[]);
        streams.set(event.streamId, frames);
      }
    }
    const frames = client === null ? [] : streams.get(client) ?? [];
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.map(frame => frame.type === 'done' ? '[DONE]' : frame.event)).toEqual(wire.map(frame => JSON.parse(frame.data)));
    const expectedEvents = failureAt === 'snapshot'
      ? ['response.created', 'response.output_item.added', 'response.output_item.done', 'error', 'response.failed']
      : announced ? ['response.created', 'error', 'response.failed'] : ['error'];
    expect(frames.filter(frame => frame.type === 'event').map(frame => frame.event.type)).toEqual(expectedEvents);
    const error = frames.find(frame => frame.type === 'event' && frame.event.type === 'error');
    expect(error).toMatchObject({ event: { error: { message: failureAt === 'render' ? 'Do not know how to serialize a BigInt' : fault.message } } });
    if (failureAt !== 'render') expect(error).toMatchObject({ event: { error: { cause: { message: 'socket reset' } } } });
    if (announced) {
      const created = frames[0] as ProtocolFrame<Extract<ClientOpenAIResponsesStreamEvent, { type: 'response.created' }>>;
      if (created.type !== 'event') throw new Error('announced response has no creation event');
      expect(frames.at(-1)).toMatchObject({ event: { response: { id: created.event.response.id, status: 'failed' } } });
    }
  });
}
