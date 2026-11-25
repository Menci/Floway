import { dumpStoreStub } from './dump/archive-fixtures.ts';
import { trackBackground } from './test-utils/background-tracker.ts';
import { initDumpStore } from '../src/dump/registry.ts';
import { handleExecutionRequest } from '../src/execution/handler.ts';
import { initBackgroundSchedulerResolver } from '../src/runtime/background.ts';
import { initExecutionCellNamespace } from '../src/runtime/execution.ts';
import { isReplayableBody, toRequestInit } from '@floway-dev/http';
import { initEnv, initFetch, initRuntimeKind, initTimingSafeEqual, InProcessExecutionCellNamespace } from '@floway-dev/platform';

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
  if (!isReplayableBody(body)) return fetch(url, toRequestInit(init, body));
  const headers = new Headers(init.headers);
  headers.set('content-length', String(body.contentLength));
  const request: RequestInit & { duplex: 'half' } = { ...toRequestInit(init, body.open()), headers, duplex: 'half' };
  return fetch(url, request);
});

initBackgroundSchedulerResolver(_c => trackBackground);
initExecutionCellNamespace(new InProcessExecutionCellNamespace(handleExecutionRequest));

initDumpStore(dumpStoreStub());
