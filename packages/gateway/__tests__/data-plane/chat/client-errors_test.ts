import { Hono } from 'hono';
import { expect, test, vi } from 'vitest';

import { emitAnthropicMessages } from '../../../src/data-plane/chat/anthropic-messages/emit.ts';
import { meterUsage as meterAnthropic } from '../../../src/data-plane/chat/anthropic-messages/meter.ts';
import { emitGeminiGenerateContent } from '../../../src/data-plane/chat/gemini-generate-content/emit.ts';
import { emitOpenAIChatCompletions } from '../../../src/data-plane/chat/openai-chat-completions/emit.ts';
import { meterUsage as meterChat } from '../../../src/data-plane/chat/openai-chat-completions/meter.ts';
import { prologueFor, serveThrough } from '../../../src/data-plane/pipeline/serve.ts';
import { initDumpBroker, initDumpStore } from '../../../src/dump/registry.ts';
import { openRunDump } from '../../../src/dump/run-sink.ts';
import { initRepo } from '../../../src/repo/index.ts';
import type { ApiKey } from '../../../src/repo/types.ts';
import { eventsOf, installDumpStubs } from '../../dump/test-fixtures.ts';
import { InMemoryRepo } from '../../repo/memory.ts';
import { mockChatGatewayCtx } from '../../test-utils/gateway-ctx.ts';
import { compose, createRunReader, defineStage, move, defer, type Deferred, type DumpEvent } from '@floway-dev/pipeline';
import { eventFrame, type ProtocolFrame, type SseFrame } from '@floway-dev/protocols/common';
import { testTelemetryModelIdentity } from '@floway-dev/test-utils';

const key: ApiKey = { id: 'client-key', userId: 1, name: 'Client key', key: 'client-key', serverSecret: '00'.repeat(32), createdAt: '2026-01-01T00:00:00Z', upstreamIds: null, deletedAt: null, dumpRetentionSeconds: 3600, openaiResponsesRetentionSeconds: 0 };
const fixtures = [
  { protocol: 'openaiChatCompletions', emit: emitOpenAIChatCompletions, meter: meterChat, initial: { id: 'chat', object: 'chat.completion.chunk', created: 1, model: 'model', choices: [{ index: 0, delta: { content: 'partial' }, finish_reason: null }] } },
  { protocol: 'anthropicMessages', emit: emitAnthropicMessages, meter: meterAnthropic, initial: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'partial' } } },
  { protocol: 'geminiGenerateContent', emit: emitGeminiGenerateContent, meter: null, initial: { candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'partial' }] } }] } },
];
type Exit = Record<string, unknown> & { 'response.http.status': number; 'response.http.headers': readonly (readonly [string, string])[] };

for (const fixture of fixtures) for (const failureAt of ['read', 'render'] as const) {
  test(`actual ${fixture.protocol} SSE records and exposes ${failureAt} failure with its original error chain`, async () => {
    initRepo(new InMemoryRepo());
    const stubs = installDumpStubs(initDumpStore, initDumpBroker);
    const pending: Promise<unknown>[] = [];
    const schedule = (work: Promise<unknown>) => { pending.push(work); };
    const dump = openRunDump(key, { method: 'POST', path: '/v1/chat', body: { bytes: new Uint8Array(), streamError: null } }, schedule, true, { upstreamCallStartedAt: null, firstOutputTokenAt: null });
    if (dump === null) throw new Error('retained request has no recording');
    const gateway = mockChatGatewayCtx({ apiKeyId: key.id, dump, wantsStream: true, backgroundScheduler: schedule });
    const fault = new Error('stream socket broke', { cause: new Error('socket reset') });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    let completed = false;
    let settle!: (outcome: { billable: readonly never[]; failed: boolean }) => void;
    const reading = defer(new Promise<{ billable: readonly never[]; failed: boolean }>(resolve => { settle = resolve; }));
    const responseKey = `response.chat.${fixture.protocol}`;
    const usageKey = `${responseKey}.streamedUsage`;
    const dial = defineStage<Record<string, unknown>, Record<string, unknown>>({
      name: 'scriptedDial', return: { provides: [responseKey, usageKey, 'response.http.headers', 'response.http.status', 'response.usage.billable'] },
      execute: async facts => move({
        ...facts, 'response.http.headers': [], 'response.http.status': 200,
        'response.usage.billable': [{ identity: testTelemetryModelIdentity, quantities: {} }],
        [usageKey]: fixture.meter === null ? reading : null,
        [responseKey]: {
          kind: 'stream', frames: {
            async *[Symbol.asyncIterator]() {
              try {
                yield eventFrame({ ...fixture.initial, ...(failureAt === 'render' ? { impossibleJson: 1n } : {}) });
                if (failureAt === 'read') throw fault;
              } finally {
                completed = true;
                settle({ billable: [], failed: true });
              }
            },
          },
        },
      }),
    });
    const pipeline = compose<Record<string, unknown>, Exit>('clientError', [fixture.emit, ...(fixture.meter === null ? [] : [fixture.meter(usageKey)]), dial]);
    const app = new Hono();
    app.post('/v1/chat', c => serveThrough(c, prologueFor(gateway, { body: { bytes: new Uint8Array(), streamError: null }, headers: [] }, dump), pipeline,
      move({ [`ingress.chat.${fixture.protocol}.wantsStream`]: true, 'ingress.chat.openaiChatCompletions.wantsUsageChunk': false }),
      facts => ({ frames: facts[`${responseKey}.rendered`] as AsyncIterable<SseFrame> }),
      facts => facts[usageKey] as Deferred<{ billable: readonly never[]; failed: boolean }>));
    const response = await app.request('/v1/chat', { method: 'POST' });
    const body = await response.text();
    await Promise.all(pending);
    expect(completed).toBe(true);
    expect(logged).not.toHaveBeenCalled();
    logged.mockRestore();
    const actual = body.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)) as { error?: { message?: string; cause?: { message: string } } });
    const error = actual.find(event => event.error !== undefined)?.error;
    expect(error?.message).toBe(failureAt === 'read' ? fault.message : 'Do not know how to serialize a BigInt');
    if (failureAt === 'read') expect(error?.cause?.message).toBe('socket reset');
    expect(body).not.toContain('[DONE]');
    expect(body).not.toContain('impossibleJson');
    const record = stubs.stored[0]!.record;
    const read = createRunReader();
    const streams = new Map<number, unknown[]>();
    let client: number | null = null;
    for (const item of eventsOf(record)) {
      const event = item as unknown as DumpEvent;
      const decoded = read(event);
      if (decoded?.facts && 'response.chat.clientFrames' in decoded.facts) client = (decoded.facts['response.chat.clientFrames'] as { stream: number }).stream;
      if (event.type === 'stream.frame') {
        const frames = streams.get(event.streamId) ?? [];
        frames.push(...(decoded?.frames as ProtocolFrame<unknown>[]).map(frame => frame.type === 'event' ? frame.event : '[DONE]'));
        streams.set(event.streamId, frames);
      }
    }
    expect(client).not.toBeNull();
    expect(streams.get(client!)).toEqual(actual);
    expect(record.meta.error).toMatchObject({ kind: 'failed' });
  });
}
