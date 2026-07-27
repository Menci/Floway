import { trackBackground } from './test-utils/background-tracker.ts';
import type { DumpBroker } from '../src/dump/broker.ts';
import { initDumpBroker, initDumpStore } from '../src/dump/registry.ts';
import type { DumpStore } from '../src/dump/store-contract.ts';
import type { DumpMetadata, StoredDumpRecord, DumpRecordId } from '../src/dump/types.ts';
import { initBackgroundSchedulerResolver } from '../src/runtime/background.ts';
import { initEnv, initRuntimeKind } from '@floway-dev/platform';

// Production always initializes the environment getter at boot. Mirror that
// here with a neutral default; tests needing real values (RUNTIME_LOCATION,
// ADMIN_KEY, …) re-init with their own getter.
initEnv(() => '');
// Tests run as 'node' by default. The few tests that exercise CF-specific
// runtime behaviour re-init this with 'cloudflare'.
initRuntimeKind('node');

initBackgroundSchedulerResolver(_c => trackBackground);

// Default no-op dump bindings keep tests that do not exercise dump persistence
// independent of that subsystem. Dump-specific tests install real or recording
// implementations.
const noopStore: DumpStore = {
  async prepareRequestBody(body) { return { encoding: 'identity', bytes: body, decodedByteLength: body.byteLength }; },
  async put(): Promise<void> { /* noop */ },
  async list(): Promise<DumpMetadata[]> { return []; },
  async get(_keyId: string, _id: DumpRecordId): Promise<StoredDumpRecord | null> { return null; },
  async deleteExpiredBatch(): Promise<number> { return 0; },
  async findOldestCreatedAt(): Promise<number | null> { return null; },
};
const noopBroker: DumpBroker = {
  async publish(): Promise<void> { /* noop */ },
  async closeChannel(): Promise<void> { /* noop */ },
  subscribe(): AsyncIterable<DumpMetadata> { return (async function*() {})(); },
};
initDumpStore(noopStore);
initDumpBroker(noopBroker);
