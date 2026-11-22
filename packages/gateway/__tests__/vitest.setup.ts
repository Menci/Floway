import { trackBackground } from './test-utils/background-tracker.ts';
import type { DumpBroker } from '../src/dump/broker.ts';
import { initDumpBroker, initDumpStore } from '../src/dump/registry.ts';
import type { DumpStore } from '../src/dump/store-contract.ts';
import type { DumpBrokerMessage, DumpMetadata, DumpRecordId } from '../src/dump/types.ts';
import { handleExecutionRequest } from '../src/execution/handler.ts';
import { initBackgroundSchedulerResolver } from '../src/runtime/background.ts';
import { initExecutionCellNamespace } from '../src/runtime/execution.ts';
import { isReplayableBody } from '@floway-dev/http';
import { initEnv, initFetch, initLogStreamStore, initRuntimeKind, initTimingSafeEqual, InProcessExecutionCellNamespace } from '@floway-dev/platform';
import type { LogStream, LogStreamStore } from '@floway-dev/platform';

// Production always initializes the environment getter at boot. Mirror that
// here with a neutral default; tests needing real values (RUNTIME_LOCATION,
// ADMIN_KEY, …) re-init with their own getter.
initEnv(() => '');
// Tests run as 'node' by default. The few tests that exercise CF-specific
// runtime behaviour re-init this with 'cloudflare'.
initRuntimeKind('node');
initTimingSafeEqual((a, b) => a.every((byte, index) => byte === b[index]));
initFetch((url, init) => {
  const body = init.body;
  if (!isReplayableBody(body)) return fetch(url, { ...init, body });
  const headers = new Headers(init.headers);
  headers.set('content-length', String(body.contentLength));
  const request: RequestInit & { duplex: 'half' } = { ...init, body: body.open(), headers, duplex: 'half' };
  return fetch(url, request);
});

initBackgroundSchedulerResolver(_c => trackBackground);
initExecutionCellNamespace(new InProcessExecutionCellNamespace(handleExecutionRequest));

// Default no-op dump bindings keep tests that do not exercise dump persistence
// independent of that subsystem. Dump-specific tests install real or recording
// implementations.
const noopStore: DumpStore = {
  createArtifactKey(keyId, startedAt, recordId) { return `dumps/v2/${keyId}/${startedAt}/${recordId}.ndjson.gz`; },
  async stageAndPutArtifact(): Promise<void> { /* noop */ },
  async commitRecord(): Promise<void> { /* noop */ },
  async list(): Promise<DumpMetadata[]> { return []; },
  async getMeta(_keyId: string, _id: DumpRecordId): Promise<DumpMetadata | null> { return null; },
  async getArtifactStream(): Promise<ReadableStream<Uint8Array> | null> { return null; },
  async deleteExpiredBatch(): Promise<number> { return 0; },
  async findOldestCreatedAt(): Promise<number | null> { return null; },
};
const noopBroker: DumpBroker = {
  async publish(): Promise<void> { /* noop */ },
  async closeChannel(): Promise<void> { /* noop */ },
  subscribe(): AsyncIterable<DumpBrokerMessage> { return (async function*() {})(); },
};
initDumpStore(noopStore);
initDumpBroker(noopBroker);

const testLogStreams = new Map<string, LogStream>();
const noopLogStream: LogStream = {
  async append(): Promise<void> { /* noop */ },
  async end(): Promise<void> { /* noop */ },
  read(): AsyncIterable<Uint8Array> { return (async function*() {})(); },
};
const noopLogStreamStore: LogStreamStore = {
  async open(streamId) {
    const existing = testLogStreams.get(streamId);
    if (existing !== undefined) return existing;
    testLogStreams.set(streamId, noopLogStream);
    return noopLogStream;
  },
  async get(streamId) { return testLogStreams.get(streamId) ?? null; },
};
initLogStreamStore(noopLogStreamStore);
