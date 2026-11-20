import { testLogStreamStore } from './log-stream.ts';
import { createRunRecorder, type RecordingPorts, type DumpMetadata, type StoredDumpRecord } from '../src/index.ts';
import type { DumpEvent } from '@floway-dev/pipeline';

export const metadata = (overrides: Partial<DumpMetadata> = {}): DumpMetadata => ({
  id: 'recorded-run',
  startedAt: 100,
  completedAt: 200,
  method: 'POST',
  path: '/v1/chat/completions',
  status: 200,
  upstream: null,
  model: 'recorded-model',
  inputTokens: null,
  outputTokens: null,
  requestBytes: 20,
  responseBytes: 40,
  durationMs: 100,
  ttftMs: null,
  targetApi: null,
  error: null,
  ...overrides,
});

export const eventsOf = (record: StoredDumpRecord): DumpEvent[] =>
  new TextDecoder('utf-8', { fatal: true }).decode(record.events).trimEnd().split('\n').map(line => JSON.parse(line) as DumpEvent);

export const recordingFixture = (overrides: Partial<RecordingPorts> = {}) => {
  const records: StoredDumpRecord[] = [];
  const published: DumpMetadata[] = [];
  const work: Promise<unknown>[] = [];
  const live = testLogStreamStore();
  const recorder = createRunRecorder({
    id: 'recorded-run', startedAt: 100,
    write: async run => {
      const events = new Uint8Array(await new Response(run.events).arrayBuffer());
      records.push({ meta: await run.metadata, events });
    },
    publish: async meta => { published.push(meta); },
    openLive: () => live.open('recorded-run'),
    background: task => { work.push(task); void task.catch(() => {}); },
    ...overrides,
  });
  return { recorder, records, published, work, live };
};
