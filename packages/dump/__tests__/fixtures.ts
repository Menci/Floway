import type { DumpMetadata, StoredDumpRecord } from '../src/index.ts';
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
