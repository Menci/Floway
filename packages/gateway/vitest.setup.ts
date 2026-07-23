import type { DumpBroker } from './src/dump/broker.ts';
import { initDumpBroker, initDumpStore } from './src/dump/registry.ts';
import type { DumpStore } from './src/dump/store-contract.ts';
import type { DumpMetadata, StoredDumpRecord, DumpRecordId } from './src/dump/types.ts';
import { initBackgroundSchedulerResolver } from './src/runtime/background.ts';
import { trackBackground } from './src/test-helpers/background-tracker.ts';
import { initEnv, initRuntimeKind } from '@floway-dev/platform';

// Production always initializes env at boot, so getEnv() never throws in a
// live request. Mirror that here with a neutral default; tests needing real
// values (RUNTIME_LOCATION, ADMIN_KEY, …) re-init with their own getter.
initEnv(() => '');
// Tests run as 'node' by default. The few tests that exercise CF-specific
// runtime behaviour re-init this with 'cloudflare'.
initRuntimeKind('node');

initBackgroundSchedulerResolver(_c => trackBackground);

// Default no-op dump bindings. The capture-dump middleware short-circuits on
// keys without retention, so every test whose fixture leaves
// dumpRetentionSeconds null never touches these. The api-keys and users
// routes call purgeAll on every delete though, so the no-op needs to be
// installed regardless. Tests that exercise the dump system itself re-init
// with their own implementations.
const noopStore: DumpStore = {
  async prepareRequestBody(body) { return { encoding: 'identity', bytes: body, decodedByteLength: body.byteLength }; },
  async put(): Promise<void> { /* noop */ },
  async list(): Promise<DumpMetadata[]> { return []; },
  async get(_keyId: string, _id: DumpRecordId): Promise<StoredDumpRecord | null> { return null; },
  async purgeAll(): Promise<void> { /* noop */ },
  async purgeExpired(): Promise<void> { /* noop */ },
};
const noopBroker: DumpBroker = {
  async publish(): Promise<void> { /* noop */ },
  async closeChannel(): Promise<void> { /* noop */ },
  subscribe(): AsyncIterable<DumpMetadata> { return (async function*() {})(); },
};
initDumpStore(noopStore);
initDumpBroker(noopBroker);
