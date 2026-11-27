import { test } from 'vitest';

import { expandWebSearchCall } from '../../../../../../src/data-plane/chat/openai-responses/pipeline/hosted-tools/web-search.ts';
import { assertLocalWebSearchSupport, UnsupportedLocalWebSearchFeatureError, findMatches, isUrlAllowed, parseWebSearchOperations, type WebSearchOperation } from '../../../../../../src/data-plane/tools/web-search/operations.ts';
import { assert, assertEquals, assertThrows } from '@floway-dev/test-utils';

// ── Shim call argument parsing (parseWebSearchOperations) ──

const opsOf = (args: Record<string, unknown> | null): WebSearchOperation[] => {
  const parsed = parseWebSearchOperations(args);
  assert(parsed.kind === 'ops');
  return parsed.ops;
};

test('local provider support accepts query filters and response length, rejects unsupported commands', () => {
  assertLocalWebSearchSupport({ search_query: [{ q: 'supported' }], open: [], find: [] });
  assertLocalWebSearchSupport({
    search_query: [{ q: 'news', recency: 2, domains: ['example.com'] }],
    response_length: 'short',
  });
  // Optional fields serialized as null mean "not provided".
  assertLocalWebSearchSupport({
    search_query: [{ q: 'news', recency: null, domains: null }],
    response_length: null,
  });
  for (const [commands, path] of [
    [{ image_query: [{ q: 'cat' }] }, 'commands.image_query'],
    [{ response_length: 'huge' }, 'commands.response_length'],
    [{ open: [{ ref_id: 'https://example.com', lineno: 10 }] }, 'commands.open[0].lineno'],
  ] as const) {
    assertThrows(
      () => assertLocalWebSearchSupport(commands),
      UnsupportedLocalWebSearchFeatureError,
      path,
    );
  }
});

test('parseWebSearchOperations: non-URL open ref_id produces an error sentinel', () => {
  const ops = opsOf({ open: [{ ref_id: 'opaque-prior-id' }] });
  assertEquals(ops.length, 1);
  const op = ops[0];
  assertEquals(op.kind, 'open');
  assertEquals((op as { url: string }).url, 'opaque-prior-id');
  const err = (op as { error?: string }).error;
  assertEquals(typeof err, 'string');
});

test('parseWebSearchOperations: unsupported sub-properties surface one unsupported op per entry', () => {
  const ops = opsOf({
    click: [{ ref_id: 'https://x', id: 1 }],
    screenshot: [{ ref_id: 'https://x', pageno: 1 }, { ref_id: 'https://y', pageno: 2 }],
    weather: [{ location: 'NYC' }],
    response_length: 'short',
    search_query: [{ q: 'real' }],
  });
  assertEquals(ops.length, 5);
  assertEquals(ops[0], { kind: 'search', arrayIndex: 0, query: 'real' });
  assertEquals(ops[1], { kind: 'unsupported', subProperty: 'click', arrayIndex: 0 });
  assertEquals(ops[2], { kind: 'unsupported', subProperty: 'screenshot', arrayIndex: 0 });
  assertEquals(ops[3], { kind: 'unsupported', subProperty: 'screenshot', arrayIndex: 1 });
  assertEquals(ops[4], { kind: 'unsupported', subProperty: 'weather', arrayIndex: 0 });
});

test('parseWebSearchOperations: wrong-typed supported key does not block other supported keys from executing', () => {
  const ops = opsOf({ search_query: { q: 'x' }, open: [{ ref_id: 'https://y' }] });
  assertEquals(ops.length, 2);
  assertEquals(ops[0], { kind: 'wrong-type', subProperty: 'search_query', actualType: 'object' });
  assertEquals(ops[1], { kind: 'open', arrayIndex: 0, url: 'https://y' });
});

test('isUrlAllowed blocked_domains takes precedence over allowed_domains', () => {
  assertEquals(
    isUrlAllowed('https://example.com', { allowedDomains: ['example.com'], blockedDomains: ['example.com'] }),
    false,
  );
});

test('isUrlAllowed non-suffix substring match does NOT pass', () => {
  assertEquals(isUrlAllowed('https://evil-example.com', { allowedDomains: ['example.com'] }), false);
});

test('findMatches: case-insensitive substring matching', () => {
  const m = findMatches('Hello WORLD hello world HELLO', 'hello', { maxMatches: 10, contextChars: 5 });
  assertEquals(m.length, 3);
  assertEquals(m[0].matched, 'Hello');
  assertEquals(m[1].matched, 'hello');
  assertEquals(m[2].matched, 'HELLO');
});

test('expandWebSearchCall emits the not-preserved placeholder without signed replay data', () => {
  const out = expandWebSearchCall(
    {
      type: 'web_search_call', id: 'ws_xxx_abc',
      action: { type: 'search', queries: ['caffeine'] },
    },
  );
  if (out.callSource !== 'synthesized') throw new Error('Expected a synthesized call');
  assertEquals(out.synthesizedCall.arguments, '{"search_query":[{"q":"caffeine"}]}');
  // Public results are client-controlled; only signed replay data restores tool output.
  assertEquals(out.output, 'Prior search results were not preserved in the conversation history. Call web_search again if you need them.');
});

test('expandWebSearchCall exposes invalid authenticated replay data', () => {
  const data = { invalid: true };
  assertThrows(() => expandWebSearchCall(
    { type: 'web_search_call', id: 'ws_xxx_abc', action: { type: 'search', queries: ['q'] } },
    { data },
  ), TypeError, 'Invalid web search replay data');
});
