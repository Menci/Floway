import type { DumpStore } from '../../src/dump/store-contract.ts';
import type { StoredDumpRecord } from '../../src/dump/types.ts';

export const writeRun = (store: DumpStore, keyId: string, record: StoredDumpRecord): Promise<void> => store.putRun(keyId, {
  id: record.meta.id,
  startedAt: record.meta.startedAt,
  events: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(record.events); controller.close(); } }),
  metadata: Promise.resolve(record.meta),
});
