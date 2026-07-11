import { afterEach, beforeEach, test } from 'vitest';

import { getCurrentColo, getRequestOrigin, getRuntimeInfo } from './runtime-info.ts';
import { initEnv, initRuntimeKind } from '@floway-dev/platform';
import { assertEquals, assertThrows } from '@floway-dev/test-utils';

// vitest.setup primes the global env getter to return `''` for every key
// and the runtime kind to `'node'`; restore those defaults after each test so
// the cloudflare-runtime cases don't leak to neighbours.
afterEach(() => {
  initEnv(() => '');
  initRuntimeKind('node');
});

test('getCurrentColo on Cloudflare returns request.cf.colo, uppercased', () => {
  initRuntimeKind('cloudflare');
  const request = new Request('https://example.test');
  Object.defineProperty(request, 'cf', { value: { colo: 'sjc' } });

  assertEquals(getCurrentColo(request), 'SJC');
});

test('getCurrentColo on Cloudflare throws when cf.colo is missing', () => {
  initRuntimeKind('cloudflare');
  const request = new Request('https://example.test');

  assertThrows(() => getCurrentColo(request), Error, 'request.cf.colo is missing');
});

test('getCurrentColo on Node uppercases RUNTIME_LOCATION when set', () => {
  initEnv(name => (name === 'RUNTIME_LOCATION' ? 'node-tokyo-1' : ''));

  assertEquals(getCurrentColo(new Request('https://example.test')), 'NODE-TOKYO-1');
});

test('getCurrentColo on Node defaults to LOCAL when RUNTIME_LOCATION is unset', () => {
  initEnv(() => undefined);

  assertEquals(getCurrentColo(new Request('https://example.test')), 'LOCAL');
});

test('getCurrentColo on Node defaults to LOCAL when RUNTIME_LOCATION is empty', () => {
  initEnv(() => '');

  assertEquals(getCurrentColo(new Request('https://example.test')), 'LOCAL');
});

test('getRuntimeInfo composes kind and colo from the same request', () => {
  initEnv(name => (name === 'RUNTIME_LOCATION' ? 'home' : ''));

  assertEquals(getRuntimeInfo(new Request('https://example.test')), { kind: 'node', colo: 'HOME' });
});

test('getRequestOrigin on Node with no forwarded proto uses the request URL origin', () => {
  assertEquals(getRequestOrigin(new Request('http://public-host/api/setup/x/setup.sh')), 'http://public-host');
});

test('getRequestOrigin on Node honors a single X-Forwarded-Proto value, keeping the request host', () => {
  const request = new Request('http://public-host/api/setup/x/setup.sh', { headers: { 'x-forwarded-proto': 'https' } });
  assertEquals(getRequestOrigin(request), 'https://public-host');
});

test('getRequestOrigin on Node ignores a comma-chained or invalid X-Forwarded-Proto', () => {
  for (const forwardedProto of ['https, http', 'HTTPS', 'ftp', '']) {
    const request = new Request('http://public-host/x', { headers: { 'x-forwarded-proto': forwardedProto } });
    assertEquals(getRequestOrigin(request), 'http://public-host');
  }
});

test('getRequestOrigin never trusts a forwarded host — the request URL host wins', () => {
  const request = new Request('https://real-host/x', { headers: { 'x-forwarded-host': 'attacker.example', 'x-forwarded-proto': 'http' } });
  assertEquals(getRequestOrigin(request), 'http://real-host');
});

test('getRequestOrigin on Cloudflare ignores a spoofed X-Forwarded-Proto and uses the request URL', () => {
  initRuntimeKind('cloudflare');
  const request = new Request('https://cf-host/api/setup/x/setup.sh', { headers: { 'x-forwarded-proto': 'http' } });
  assertEquals(getRequestOrigin(request), 'https://cf-host');
});

beforeEach(() => {
  initRuntimeKind('node');
});
