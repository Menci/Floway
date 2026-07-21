import { test } from 'vitest';

import { resolveServerToolName } from '../server-tool-shim.ts';
import {
  isHostedWebSearchTool,
  prepareToolsForShim,
  SHIM_TOOL_NAME,
  synthesizeWebSearchCallId,
  transformInputItemsForWebSearch,
  WEB_SEARCH_HOSTED_TYPES,
  type WebSearchCallPrivatePayload,
} from './web-search.ts';
import { findMatches, formatMatches, isUrlAllowed, parseWebSearchOperations, type WebSearchOperation } from '../../../../tools/web-search/operations.ts';
import { truncatePreservingCodePoints } from '../../../shared/text.ts';
import type { ResponsesTool, ResponsesWebSearchAction, ResponsesWebSearchResult } from '@floway-dev/protocols/responses';
import { assert, assertEquals, assertFalse } from '@floway-dev/test-utils';

// ── Shim call argument parsing (parseWebSearchOperations) ──

const opsOf = (args: Record<string, unknown> | null): WebSearchOperation[] => {
  const parsed = parseWebSearchOperations(args);
  assert(parsed.kind === 'ops');
  return parsed.ops;
};

test('parseWebSearchOperations returns ops:[] for empty object', () => {
  assertEquals(parseWebSearchOperations({}), { kind: 'ops', ops: [] });
});

test('parseWebSearchOperations parses one search_query entry', () => {
  assertEquals(
    opsOf({ search_query: [{ q: 'hello' }] }),
    [{ kind: 'search', arrayIndex: 0, query: 'hello' }],
  );
});

test('parseWebSearchOperations parses multiple search_query entries with stable arrayIndex', () => {
  assertEquals(
    opsOf({ search_query: [{ q: 'a' }, { q: 'b' }, { q: 'c' }] }),
    [
      { kind: 'search', arrayIndex: 0, query: 'a' },
      { kind: 'search', arrayIndex: 1, query: 'b' },
      { kind: 'search', arrayIndex: 2, query: 'c' },
    ],
  );
});

test('parseWebSearchOperations parses open entry with URL ref_id', () => {
  assertEquals(
    opsOf({ open: [{ ref_id: 'https://example.com' }] }),
    [{ kind: 'open', arrayIndex: 0, url: 'https://example.com' }],
  );
});

test('parseWebSearchOperations parses find entry with URL ref_id and pattern', () => {
  assertEquals(
    opsOf({ find: [{ ref_id: 'https://example.com', pattern: 'needle' }] }),
    [{ kind: 'find', arrayIndex: 0, url: 'https://example.com', pattern: 'needle' }],
  );
});

test('parseWebSearchOperations: non-URL open ref_id produces an error sentinel', () => {
  const ops = opsOf({ open: [{ ref_id: 'opaque-prior-id' }] });
  assertEquals(ops.length, 1);
  const op = ops[0];
  assertEquals(op.kind, 'open');
  assertEquals((op as { url: string }).url, 'opaque-prior-id');
  const err = (op as { error?: string }).error;
  assertEquals(typeof err, 'string');
  assertEquals(err!.startsWith('Error: ref_id must be a fully-qualified URL'), true);
  assertEquals(err!.includes('opaque-prior-id'), true);
});

test('parseWebSearchOperations: non-URL find ref_id produces an error sentinel', () => {
  const ops = opsOf({ find: [{ ref_id: 'cursor-123', pattern: 'p' }] });
  assertEquals(ops.length, 1);
  const op = ops[0];
  assertEquals(op.kind, 'find');
  assertEquals((op as { url: string }).url, 'cursor-123');
  assertEquals((op as { pattern: string }).pattern, 'p');
  const err = (op as { error?: string }).error;
  assertEquals(typeof err, 'string');
  assertEquals(err!.includes('cursor-123'), true);
});

test('parseWebSearchOperations: multi-action batched call returns all ops in order search→open→find', () => {
  const ops = opsOf({
    search_query: [{ q: 'a' }],
    open: [{ ref_id: 'https://x' }],
    find: [{ ref_id: 'https://y', pattern: 'p' }],
  });
  assertEquals(ops.map(o => o.kind), ['search', 'open', 'find']);
});

test('parseWebSearchOperations: unsupported sub-properties surface one unsupported op per entry', () => {
  const ops = opsOf({
    click: [{ ref_id: 'https://x', id: 1 }],
    screenshot: [{ ref_id: 'https://x', pageno: 1 }, { ref_id: 'https://y', pageno: 2 }],
    weather: [{ location: 'NYC' }],
    response_length: 'short',
    search_query: [{ q: 'real' }],
  });
  assertEquals(ops.length, 6);
  assertEquals(ops[0], { kind: 'search', arrayIndex: 0, query: 'real' });
  assertEquals(ops[1], { kind: 'unsupported', subProperty: 'click', arrayIndex: 0 });
  assertEquals(ops[2], { kind: 'unsupported', subProperty: 'screenshot', arrayIndex: 0 });
  assertEquals(ops[3], { kind: 'unsupported', subProperty: 'screenshot', arrayIndex: 1 });
  assertEquals(ops[4], { kind: 'unsupported', subProperty: 'weather', arrayIndex: 0 });
  assertEquals(ops[5], { kind: 'unsupported', subProperty: 'response_length', arrayIndex: 0 });
});

test('parseWebSearchOperations: missing q on search_query entry surfaces a missing-argument error sentinel', () => {
  const ops = opsOf({ search_query: [{}] });
  assertEquals(ops.length, 1);
  const op = ops[0];
  assertEquals(op.kind, 'search');
  assertEquals((op as { query: string }).query, '');
  assertEquals(typeof (op as { error?: string }).error, 'string');
  assert((op as { error: string }).error.includes('"q"'));
});

test('parseWebSearchOperations: missing ref_id on open entry surfaces a missing-argument error sentinel', () => {
  const ops = opsOf({ open: [{}] });
  assertEquals(ops.length, 1);
  const op = ops[0];
  assertEquals(op.kind, 'open');
  assertEquals((op as { url: string }).url, '');
  assert((op as { error: string }).error.includes('"ref_id"'));
});

test('parseWebSearchOperations: missing pattern on find entry surfaces a missing-argument error sentinel', () => {
  const ops = opsOf({ find: [{ ref_id: 'https://x' }] });
  assertEquals(ops.length, 1);
  const op = ops[0];
  assertEquals(op.kind, 'find');
  assertEquals((op as { pattern: string }).pattern, '');
  assert((op as { error: string }).error.includes('"pattern"'));
});

test('parseWebSearchOperations: array values for non-array shape are skipped', () => {
  assertEquals(opsOf({ search_query: 'oops' }), [
    { kind: 'wrong-type', subProperty: 'search_query', actualType: 'string' },
  ]);
});

test('parseWebSearchOperations: supported key with non-array value surfaces a wrong-type op (search_query)', () => {
  // A model that populates `search_query: {"q":"x"}` (or any
  // non-array) used to be silently dropped because the array guard
  // skipped it. Surface as a model-visible `wrong-type` op so the
  // model learns the call was malformed instead of seeing a phantom
  // success.
  assertEquals(opsOf({ search_query: { q: 'x' } }), [
    { kind: 'wrong-type', subProperty: 'search_query', actualType: 'object' },
  ]);
});

test('parseWebSearchOperations: wrong-typed supported key does not block other supported keys from executing', () => {
  const ops = opsOf({ search_query: { q: 'x' }, open: [{ ref_id: 'https://y' }] });
  assertEquals(ops.length, 2);
  assertEquals(ops[0], { kind: 'wrong-type', subProperty: 'search_query', actualType: 'object' });
  assertEquals(ops[1], { kind: 'open', arrayIndex: 0, url: 'https://y' });
});

test('parseWebSearchOperations: wrong-typed open / find surface as wrong-type ops', () => {
  assertEquals(opsOf({ open: 'https://x' }), [
    { kind: 'wrong-type', subProperty: 'open', actualType: 'string' },
  ]);
  assertEquals(opsOf({ find: null }), [
    { kind: 'wrong-type', subProperty: 'find', actualType: 'null' },
  ]);
});

// ── IR builders (private to web-search.ts; exercised end-to-end below) ──

test('synthesizeWebSearchCallId produces unique canonical web-search ids', () => {
  const a = synthesizeWebSearchCallId();
  const b = synthesizeWebSearchCallId();
  assert(/^ws_[0-9a-f]{32}$/.test(a));
  assert(/^ws_[0-9a-f]{32}$/.test(b));
  assert(a !== b);
});

// ── truncatePreservingCodePoints boundary cases ───────────────────────

test('truncatePreservingCodePoints: empty string is a no-op', () => {
  assertEquals(truncatePreservingCodePoints('', 512), '');
});

test('truncatePreservingCodePoints: string of exactly `max` length is unchanged (no ellipsis injected)', () => {
  const s = 'a'.repeat(512);
  assertEquals(truncatePreservingCodePoints(s, 512), s);
});

test('truncatePreservingCodePoints: high surrogate at position max-1 walks back to drop the orphan', () => {
  // U+1F600 (grinning face) is a surrogate pair: high D83D + low DE00.
  // Place the high surrogate at index max-1 (= 9) so a naive
  // slice(0, max) would retain the orphan high surrogate. The helper
  // must walk back one code unit and slice at max-1 (= 9), producing
  // a 9-char string with no orphan.
  const prefix = 'a'.repeat(9); // chars 0..8
  const emoji = '😀'; // chars 9..10 → high at 9, low at 10
  const suffix = 'b';
  const input = prefix + emoji + suffix; // length 12
  const out = truncatePreservingCodePoints(input, 10);
  assertEquals(out.length, 9);
  assertEquals(out, prefix);
  // Sanity: no orphan high surrogate in the output.
  for (let i = 0; i < out.length; i++) {
    const code = out.charCodeAt(i);
    assertFalse(code >= 0xD800 && code <= 0xDBFF);
  }
});

// ── Backend dispatch helpers (isUrlAllowed / findMatches / formatMatches) ──

test('isUrlAllowed returns true when no filters set', () => {
  assertEquals(isUrlAllowed('https://example.com', {}), true);
});

test('isUrlAllowed allowed_domains: exact host match passes', () => {
  assertEquals(isUrlAllowed('https://example.com/page', { allowedDomains: ['example.com'] }), true);
});

test('isUrlAllowed allowed_domains: subdomain suffix-matches', () => {
  assertEquals(isUrlAllowed('https://www.example.com/page', { allowedDomains: ['example.com'] }), true);
  assertEquals(isUrlAllowed('https://sub.example.com/page', { allowedDomains: ['example.com'] }), true);
});

test('isUrlAllowed allowed_domains: unrelated host is blocked', () => {
  assertEquals(isUrlAllowed('https://other.com', { allowedDomains: ['example.com'] }), false);
});

test('isUrlAllowed blocked_domains: exact match is blocked', () => {
  assertEquals(isUrlAllowed('https://example.com', { blockedDomains: ['example.com'] }), false);
});

test('isUrlAllowed blocked_domains: subdomain is blocked', () => {
  assertEquals(isUrlAllowed('https://www.example.com', { blockedDomains: ['example.com'] }), false);
});

test('isUrlAllowed blocked_domains takes precedence over allowed_domains', () => {
  assertEquals(
    isUrlAllowed('https://example.com', { allowedDomains: ['example.com'], blockedDomains: ['example.com'] }),
    false,
  );
});

test('isUrlAllowed invalid URL is blocked defensively', () => {
  assertEquals(isUrlAllowed('not-a-url', { allowedDomains: ['x.com'] }), false);
});

test('isUrlAllowed non-suffix substring match does NOT pass', () => {
  assertEquals(isUrlAllowed('https://evil-example.com', { allowedDomains: ['example.com'] }), false);
});

test('isUrlAllowed empty allowedDomains list behaves like no filter', () => {
  assertEquals(isUrlAllowed('https://example.com', { allowedDomains: [] }), true);
});

test('findMatches: case-insensitive substring matching', () => {
  const m = findMatches('Hello WORLD hello world HELLO', 'hello', { maxMatches: 10, contextChars: 5 });
  assertEquals(m.length, 3);
  assertEquals(m[0].matched, 'Hello');
  assertEquals(m[1].matched, 'hello');
  assertEquals(m[2].matched, 'HELLO');
});

test('findMatches: respects maxMatches cap', () => {
  const text = 'foo '.repeat(20);
  assertEquals(findMatches(text, 'foo', { maxMatches: 5, contextChars: 5 }).length, 5);
});

test('findMatches: empty array on no match', () => {
  assertEquals(findMatches('hello', 'xyz', { maxMatches: 10, contextChars: 5 }), []);
});

test('findMatches: empty pattern returns empty array', () => {
  assertEquals(findMatches('hello', '', { maxMatches: 10, contextChars: 5 }), []);
});

test('findMatches: contextChars trims around the match', () => {
  const m = findMatches('AAAAAAAAAAneedleBBBBBBBBBB', 'needle', { maxMatches: 10, contextChars: 5 });
  assertEquals(m.length, 1);
  assertEquals(m[0].before, 'AAAAA');
  assertEquals(m[0].matched, 'needle');
  assertEquals(m[0].after, 'BBBBB');
});

test('findMatches: pattern at string boundaries', () => {
  const m = findMatches('needleXXXX', 'needle', { maxMatches: 1, contextChars: 5 });
  assertEquals(m[0].before, '');
  assertEquals(m[0].after, 'XXXX');
});

test('findMatches: pattern at end of string', () => {
  const m = findMatches('XXXXneedle', 'needle', { maxMatches: 1, contextChars: 5 });
  assertEquals(m[0].before, 'XXXX');
  assertEquals(m[0].after, '');
});

test('findMatches: overlapping matches not double-counted (search resumes past match)', () => {
  const m = findMatches('aaaa', 'aa', { maxMatches: 10, contextChars: 0 });
  assertEquals(m.length, 2);
});

test('formatMatches: renders header + numbered matches with brackets', () => {
  const out = formatMatches('cat', 'https://x', [{ before: 'a ', matched: 'cat', after: ' on mat' }]);
  assertEquals(out.includes('1 match for pattern: `cat`'), true);
  assertEquals(out.includes('Match 1:'), true);
  assertEquals(out.includes('"...a [cat] on mat..."'), true);
});

test('formatMatches: empty matches returns no-matches phrase including URL', () => {
  assertEquals(formatMatches('cat', 'https://x', []), 'No matching `cat` found on https://x.');
});

test('formatMatches: multi-match output uses Match N: headers', () => {
  const out = formatMatches('cat', 'https://x', [
    { before: 'a ', matched: 'cat', after: ' b' },
    { before: 'c ', matched: 'cat', after: ' d' },
  ]);
  assertEquals(out.includes('2 matches for pattern: `cat`'), true);
  assertEquals(out.includes('Match 1:'), true);
  assertEquals(out.includes('Match 2:'), true);
});

// ── Tool detection, filter prep, and name resolution ──

const SHIM_TOOL = SHIM_TOOL_NAME;
const hostedVariants = ['web_search', 'web_search_2025_08_26', 'web_search_preview', 'web_search_preview_2025_03_11'] as const;

const prepare = (tools: ResponsesTool[]) => {
  const result = prepareToolsForShim(tools);
  assert(result.ok);
  return { filters: result.filters };
};

test('isHostedWebSearchTool recognizes every hosted variant', () => {
  assertEquals([...WEB_SEARCH_HOSTED_TYPES].sort(), [...hostedVariants].sort());
  for (const type of hostedVariants) assertEquals(isHostedWebSearchTool({ type } as ResponsesTool), true);
  assertEquals(isHostedWebSearchTool({ type: 'function', name: 'x', parameters: {}, strict: false }), false);
  assertEquals(isHostedWebSearchTool({ type: 'custom', name: 'x' }), false);
});

for (const type of hostedVariants) {
  test(`prepareToolsForShim accepts ${type} and extracts default filters`, () => {
    assertEquals(prepare([{ type } as ResponsesTool]).filters, { maxResults: 20 });
  });
}

test('prepareToolsForShim extracts filters, user_location, and context size', () => {
  const { filters } = prepare([{
    type: 'web_search',
    filters: { allowed_domains: ['a.com'], blocked_domains: ['b.com'] },
    user_location: { country: 'JP', city: 'Tokyo' },
    search_context_size: 'high',
  } as ResponsesTool]);
  assertEquals(filters.allowedDomains, ['a.com']);
  assertEquals(filters.blockedDomains, ['b.com']);
  assertEquals(filters.userLocation, { country: 'JP', city: 'Tokyo' });
  assertEquals(filters.maxResults, 40);
});

test('prepareToolsForShim selects the last web_search declaration as one configuration', () => {
  const { filters } = prepare([
    {
      type: 'web_search',
      filters: { allowed_domains: ['first.example'] },
      user_location: { country: 'US' },
      search_context_size: 'high',
    },
    {
      type: 'web_search_preview',
      filters: { blocked_domains: ['last.example'] },
      user_location: { country: 'SG' },
      search_context_size: 'low',
    },
  ]);
  assertEquals(filters, {
    blockedDomains: ['last.example'],
    userLocation: { country: 'SG' },
    maxResults: 10,
  });
});

test('prepareToolsForShim passes through with empty filters when no hosted web_search exists', () => {
  const fn: ResponsesTool = { type: 'function', name: 'foo', parameters: {}, strict: false };
  assertEquals(prepare([fn]).filters, {});
});

test('resolveServerToolName returns the first free sequential name', () => {
  assertEquals(resolveServerToolName(SHIM_TOOL, []), SHIM_TOOL);
  assertEquals(resolveServerToolName(SHIM_TOOL, [{ type: 'function', name: SHIM_TOOL, parameters: {}, strict: false }]), `${SHIM_TOOL}_2`);
  assertEquals(resolveServerToolName(SHIM_TOOL, [
    { type: 'function', name: SHIM_TOOL, parameters: {}, strict: false },
    { type: 'custom', name: `${SHIM_TOOL}_2` },
  ]), `${SHIM_TOOL}_3`);
});

test('prepareToolsForShim rejects invalid hosted fields', () => {
  const result = prepareToolsForShim([{ type: 'web_search', search_context_size: 'huge' } as unknown as ResponsesTool]);
  assertEquals(result.ok, false);
});

// ── Private-payload restoration (transformInputItemsForWebSearch) ──

const makePrivatePayload = (
  upstreamCallId: string,
  upstreamArgs: string,
  action: ResponsesWebSearchAction,
  results: ResponsesWebSearchResult[],
): WebSearchCallPrivatePayload => ({
  v: 1,
  functionCallItem: {
    type: 'function_call',
    call_id: upstreamCallId,
    name: 'web_search',
    arguments: upstreamArgs,
    status: 'completed',
  },
  ir: { action, results },
});

test('transformInputItemsForWebSearch replays the upstream function_call verbatim when a private payload exists', () => {
  // One wsc maps 1:1 to one shim call. The shim's
  // jsonrepair-canonical args and the per-op output are persisted on
  // this single row.
  const payload = makePrivatePayload(
    'call_orig_xyz',
    '{"search_query":[{"q":"caffeine","topn":5}]}',
    { type: 'search', query: 'caffeine', queries: ['caffeine'] },
    [{ type: 'text_result', url: 'u', title: 't', snippet: 'cached body' }],
  );
  const map = new Map<string, unknown>([['ws_xxx_abc', payload]]);
  const out = transformInputItemsForWebSearch(
    [{ type: 'web_search_call', id: 'ws_xxx_abc' }],
    'web_search',
    id => map.get(id),
  );
  assertEquals(out.length, 2);
  const [fc, fco] = out as [{ type: string; name: string; arguments: string; call_id: string }, { type: string; output: string; call_id: string }];
  assertEquals(fc.type, 'function_call');
  assertEquals(fc.call_id, 'call_orig_xyz');
  assertEquals(fc.name, 'web_search');
  // The upstream's call_id and canonical args are preserved bit-exact —
  // `topn` survives even though the IR drops it.
  assertEquals(fc.arguments, '{"search_query":[{"q":"caffeine","topn":5}]}');
  assertEquals(fco.call_id, 'call_orig_xyz');
  assert(fco.output.includes('cached body'));
});

test('transformInputItemsForWebSearch replays each echoed wsc independently (one pair per wsc)', () => {
  // Two distinct shim calls (different upstream call_ids) → two replay
  // pairs, one per wsc.
  const p1 = makePrivatePayload('call_u1', '{"search_query":[{"q":"q1"}]}',
    { type: 'search', queries: ['q1'] }, [{ type: 'text_result', url: 'u1', title: 't1', snippet: 'body1' }]);
  const p2 = makePrivatePayload('call_u2', '{"search_query":[{"q":"q2"}]}',
    { type: 'search', queries: ['q2'] }, [{ type: 'text_result', url: 'u2', title: 't2', snippet: 'body2' }]);
  const map = new Map<string, unknown>([['ws_one', p1], ['ws_two', p2]]);
  const out = transformInputItemsForWebSearch(
    [
      { type: 'web_search_call', id: 'ws_one' },
      { type: 'web_search_call', id: 'ws_two' },
    ],
    'web_search',
    id => map.get(id),
  );
  assertEquals(out.length, 4);
  const callIds = out.map(it => (it as { call_id?: unknown }).call_id).filter((id): id is string => typeof id === 'string');
  assertEquals(callIds, ['call_u1', 'call_u1', 'call_u2', 'call_u2']);
  const outputs = out.filter(it => (it as { type: string }).type === 'function_call_output') as Array<{ output: string }>;
  assert(outputs[0].output.includes('body1'));
  assert(outputs[1].output.includes('body2'));
});

test('transformInputItemsForWebSearch emits the not-preserved placeholder even when the wire item still carries results (no payload → we do not trust client-supplied results)', () => {
  const out = transformInputItemsForWebSearch(
    [{
      type: 'web_search_call', id: 'ws_xxx_abc',
      action: { type: 'search', queries: ['caffeine'] },
      results: [{ type: 'text_result', url: 'u', title: 't', snippet: 'public-wire body' }],
    }],
    'web_search',
  );
  assertEquals(out.length, 2);
  const fc = out[0] as { type: string; arguments: string };
  const fco = out[1] as { type: string; output: string };
  // The synthesized function_call mirrors the wire action shape so the
  // model still sees what it had asked for.
  assertEquals(fc.arguments, '{"search_query":[{"q":"caffeine"}]}');
  // ... but the function_call_output is the placeholder — we deliberately
  // ignore the wire `results` field, since we have no way to verify it
  // matches what the gateway actually returned on turn 1.
  assertEquals(fco.output, 'Prior search results were not preserved in the conversation history. Call web_search again if you need them.');
});

test('transformInputItemsForWebSearch emits the not-preserved placeholder when results are missing and no private payload exists', () => {
  const out = transformInputItemsForWebSearch(
    [{ type: 'web_search_call', id: 'ws_xxx_abc', action: { type: 'search', queries: ['q'] } }],
    'web_search',
  );
  const fco = out[1] as { type: string; output: string };
  assertEquals(fco.output, 'Prior search results were not preserved in the conversation history. Call web_search again if you need them.');
});

test('transformInputItemsForWebSearch ignores a stashed value with the wrong schema version (forward-compat)', () => {
  const map = new Map<string, unknown>([['ws_xxx_abc', { v: 99, anything: 'goes' }]]);
  // Falls back to public-wire reconstruction; no crash, no false hydration.
  const out = transformInputItemsForWebSearch(
    [{ type: 'web_search_call', id: 'ws_xxx_abc', action: { type: 'search', queries: ['q'] } }],
    'web_search',
    id => map.get(id),
  );
  const fco = out[1] as { type: string; output: string };
  assertEquals(fco.output, 'Prior search results were not preserved in the conversation history. Call web_search again if you need them.');
});
