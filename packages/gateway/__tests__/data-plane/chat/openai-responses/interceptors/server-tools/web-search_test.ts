import { test } from 'vitest';

import { resolveServerToolName } from '../../../../../../src/data-plane/chat/openai-responses/interceptors/server-tool-shim.ts';
import {
  alphaSearchSettingsFromHosted,
  isHostedWebSearchTool,
  prepareToolsForShim,
  SHIM_TOOL_NAME,
  expandWebSearchCall,
  WEB_SEARCH_HOSTED_TYPES,
} from '../../../../../../src/data-plane/chat/openai-responses/interceptors/server-tools/web-search.ts';
import { assertLocalWebSearchSupport, findMatches, formatMatches, isUrlAllowed, parseWebSearchOperations, type WebSearchOperation } from '../../../../../../src/data-plane/tools/web-search/operations.ts';
import type { OpenAIResponsesHostedTool, OpenAIResponsesTool } from '@floway-dev/protocols/openai-responses';
import { assert, assertEquals, assertThrows } from '@floway-dev/test-utils';

// ── Shim call argument parsing (parseWebSearchOperations) ──

const opsOf = (args: Record<string, unknown> | null): WebSearchOperation[] => {
  const parsed = parseWebSearchOperations(args);
  assert(parsed.kind === 'ops');
  return parsed.ops;
};

test('alpha-search settings preserve every OpenAI setting supported by passthrough', () => {
  const hosted: OpenAIResponsesHostedTool = {
    type: 'web_search',
    user_location: { type: 'approximate', country: 'SG' },
    search_context_size: 'high',
    filters: { allowed_domains: ['example.com'] },
    image_settings: { max_results: 4, caption: true },
    allowed_callers: ['direct', 'shell'],
    external_web_access: 'live',
    search_content_types: ['text', 'image'],
    return_token_budget: 'unlimited',
  };
  assertEquals(alphaSearchSettingsFromHosted(hosted), {
    user_location: hosted.user_location,
    search_context_size: 'high',
    filters: hosted.filters,
    image_settings: hosted.image_settings,
    allowed_callers: hosted.allowed_callers,
    external_web_access: 'live',
  });
});

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
      Error,
      `The configured web search provider does not implement OpenAI search feature \`${path}\`.`,
    );
  }
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

test('parseWebSearchOperations preserves query-level domains and recency', () => {
  assertEquals(
    opsOf({ search_query: [{ q: 'news', domains: ['example.com'], recency: 7 }] }),
    [{ kind: 'search', arrayIndex: 0, query: 'news', domains: ['example.com'], recencyDays: 7 }],
  );
});

test('parseWebSearchOperations ignores null optional fields', () => {
  assertEquals(
    opsOf({ search_query: [{ q: 'news', domains: null, recency: null }] }),
    [{ kind: 'search', arrayIndex: 0, query: 'news' }],
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
  assertEquals(ops.length, 5);
  assertEquals(ops[0], { kind: 'search', arrayIndex: 0, query: 'real' });
  assertEquals(ops[1], { kind: 'unsupported', subProperty: 'click', arrayIndex: 0 });
  assertEquals(ops[2], { kind: 'unsupported', subProperty: 'screenshot', arrayIndex: 0 });
  assertEquals(ops[3], { kind: 'unsupported', subProperty: 'screenshot', arrayIndex: 1 });
  assertEquals(ops[4], { kind: 'unsupported', subProperty: 'weather', arrayIndex: 0 });
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

test('isUrlAllowed allowed_domains: subdomain suffix-matches', () => {
  assertEquals(isUrlAllowed('https://www.example.com/page', { allowedDomains: ['example.com'] }), true);
  assertEquals(isUrlAllowed('https://sub.example.com/page', { allowedDomains: ['example.com'] }), true);
});

test('isUrlAllowed allowed_domains: unrelated host is blocked', () => {
  assertEquals(isUrlAllowed('https://other.com', { allowedDomains: ['example.com'] }), false);
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

// ── Tool detection, filter prep, and name resolution ──

const SHIM_TOOL = SHIM_TOOL_NAME;
const hostedVariants = ['web_search', 'web_search_2025_08_26', 'web_search_preview', 'web_search_preview_2025_03_11'] as const;

const prepare = (tools: OpenAIResponsesTool[]) => {
  const result = prepareToolsForShim(tools);
  assert(result.ok);
  return { filters: result.filters };
};

test('isHostedWebSearchTool recognizes every hosted variant', () => {
  assertEquals([...WEB_SEARCH_HOSTED_TYPES].sort(), [...hostedVariants].sort());
  for (const type of hostedVariants) assertEquals(isHostedWebSearchTool({ type } as OpenAIResponsesTool), true);
  assertEquals(isHostedWebSearchTool({ type: 'function', name: 'x', parameters: {}, strict: false }), false);
  assertEquals(isHostedWebSearchTool({ type: 'custom', name: 'x' }), false);
});

test('prepareToolsForShim extracts default filters from a bare hosted tool', () => {
  assertEquals(prepare([{ type: 'web_search_preview' }]).filters, { maxResults: 20 });
});

test('prepareToolsForShim extracts filters, user_location, and context size', () => {
  const { filters } = prepare([{
    type: 'web_search',
    filters: { allowed_domains: ['a.com'], blocked_domains: ['b.com'] },
    user_location: { country: 'JP', city: 'Tokyo' },
    search_context_size: 'high',
  } as OpenAIResponsesTool]);
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
  const fn: OpenAIResponsesTool = { type: 'function', name: 'foo', parameters: {}, strict: false };
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

test('expandWebSearchCall renders its replay IR without reconstructing the original call', () => {
  const out = expandWebSearchCall(
    { type: 'web_search_call', id: 'ws_xxx_abc', action: { type: 'search', query: 'caffeine', queries: ['caffeine'] } },
    { data: { action: { type: 'search', query: 'caffeine', queries: ['caffeine'] }, results: [{ type: 'text_result', url: 'u', title: 't', snippet: 'cached body' }] } },
  );
  assertEquals(out.callSource, 'replay');
  assert(typeof out.output === 'string');
  assert(out.output.includes('cached body'));
});

test('expandWebSearchCall emits the not-preserved placeholder even when the wire item still carries results (no payload → we do not trust client-supplied results)', () => {
  const out = expandWebSearchCall(
    {
      type: 'web_search_call', id: 'ws_xxx_abc',
      action: { type: 'search', queries: ['caffeine'] },
      results: [{ type: 'text_result', url: 'u', title: 't', snippet: 'public-wire body' }],
    },
  );
  if (out.callSource !== 'synthesized') throw new Error('Expected a synthesized call');
  assertEquals(out.synthesizedCall.arguments, '{"search_query":[{"q":"caffeine"}]}');
  // Public results are client-controlled; only signed replay data restores tool output.
  assertEquals(out.output, 'Prior search results were not preserved in the conversation history. Call web_search again if you need them.');
});

test.each([null, { invalid: true }])('expandWebSearchCall exposes invalid authenticated replay data: %j', data => {
  assertThrows(() => expandWebSearchCall(
    { type: 'web_search_call', id: 'ws_xxx_abc', action: { type: 'search', queries: ['q'] } },
    { data },
  ), TypeError, 'Invalid web search replay data');
});
