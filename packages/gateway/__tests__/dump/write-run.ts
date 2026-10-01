import type { DumpStore, StoredDumpRecord } from '@floway-dev/dump/types';

export const writeRun = (store: DumpStore, keyId: string, record: StoredDumpRecord): Promise<void> => store.putRun(keyId, {
  id: record.meta.id,
  startedAt: record.meta.startedAt,
  events: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(record.events); controller.close(); } }),
  metadata: Promise.resolve(record.meta),
});
