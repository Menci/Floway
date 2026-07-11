import { afterEach, beforeEach, test } from 'vitest';

import { getRuntimeLocation, getRuntimeInfo } from './runtime-info.ts';
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

test('getRuntimeLocation on Node uppercases RUNTIME_LOCATION when set', () => {
  initEnv(name => (name === 'RUNTIME_LOCATION' ? 'node-tokyo-1' : ''));

  assertEquals(getRuntimeLocation(new Request('https://example.test')), 'NODE-TOKYO-1');
});

test('getRuntimeLocation on Node defaults to LOCAL when RUNTIME_LOCATION is unset', () => {
  initEnv(() => undefined);

  assertEquals(getRuntimeLocation(new Request('https://example.test')), 'LOCAL');
});

test('getRuntimeLocation on Node defaults to LOCAL when RUNTIME_LOCATION is empty', () => {
  initEnv(() => '');

  assertEquals(getRuntimeLocation(new Request('https://example.test')), 'LOCAL');
});

test('getRuntimeInfo composes kind and runtimeLocation from the same request', () => {
  initEnv(name => (name === 'RUNTIME_LOCATION' ? 'home' : ''));

  assertEquals(getRuntimeInfo(new Request('https://example.test')), { kind: 'node', runtimeLocation: 'HOME' });
});

beforeEach(() => {
  initRuntimeKind('node');
});
