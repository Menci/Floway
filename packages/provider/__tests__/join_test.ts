import { test } from 'vitest';

import { joinBaseAndPath, validateUpstreamPath } from '../src/join.ts';
import { assertEquals, assertFalse } from '@floway-dev/test-utils';

test('validateUpstreamPath accepts a leading-slash absolute path', () => {
  const result = validateUpstreamPath('/v1/messages', 'messages');
  assertEquals(result, { ok: true, value: '/v1/messages' });
});

test('validateUpstreamPath trims surrounding whitespace', () => {
  const result = validateUpstreamPath('  /api/v1/chat  ', 'chat');
  assertEquals(result, { ok: true, value: '/api/v1/chat' });
});

test('validateUpstreamPath rejects non-string input', () => {
  const result = validateUpstreamPath(42, 'chat');
  assertFalse(result.ok);
});

test('validateUpstreamPath rejects empty string', () => {
  const result = validateUpstreamPath('', 'chat');
  assertFalse(result.ok);
});

test('validateUpstreamPath rejects paths without a leading slash', () => {
  const result = validateUpstreamPath('v1/chat/completions', 'chat');
  assertFalse(result.ok);
});

test('validateUpstreamPath rejects double slashes', () => {
  const result = validateUpstreamPath('/api//v1/chat', 'chat');
  assertFalse(result.ok);
});

test('validateUpstreamPath rejects relative segments', () => {
  for (const bad of ['/api/./chat', '/api/../chat']) {
    const result = validateUpstreamPath(bad, 'chat');
    assertFalse(result.ok, `expected ${bad} to be rejected`);
  }
});

test('joinBaseAndPath strips trailing base slashes', () => {
  assertEquals(joinBaseAndPath('https://oai.example.com//', '/v1/chat'), 'https://oai.example.com/v1/chat');
});

test('joinBaseAndPath preserves a base subpath', () => {
  assertEquals(joinBaseAndPath('https://host.example/api', '/v1/messages'), 'https://host.example/api/v1/messages');
});
