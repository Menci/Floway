import { afterEach, beforeEach, test } from 'vitest';

import { getRuntimeLocation } from '../../src/runtime/runtime-info.ts';
import { initEnv, initRuntimeKind } from '@floway-dev/platform';
import { assertEquals, assertThrows } from '@floway-dev/test-utils';

// vitest.setup primes the global env getter to return `''` for every key
// and the runtime kind to `'node'`; restore those defaults after each test so
// the cloudflare-runtime cases don't leak to neighbours.
afterEach(() => {
  initEnv(() => '');
  initRuntimeKind('node');
});

test('getRuntimeLocation on Cloudflare returns request.cf.colo, uppercased', () => {
  initRuntimeKind('cloudflare');
  const request = new Request('https://example.test');
  Object.defineProperty(request, 'cf', { value: { colo: 'sjc' } });

  assertEquals(getRuntimeLocation(request), 'SJC');
});

test('getRuntimeLocation on Cloudflare throws when cf.colo is missing', () => {
  initRuntimeKind('cloudflare');
  const request = new Request('https://example.test');

  assertThrows(() => getRuntimeLocation(request), Error, 'request.cf.colo is missing');
});

beforeEach(() => {
  initRuntimeKind('node');
});
