import { describe, test } from 'vitest';

import type { ResponsesTool } from './index.ts';
import { NAMESPACE_NAME_DELIMITER, flattenToolSearchFamilyTools, unpackNamespaceTools, unprefixNamespaceToolCall } from './tool-search-family.ts';
import { assert, assertEquals } from '@floway-dev/test-utils';

describe('NAMESPACE_NAME_DELIMITER', () => {
  test('is `__` — the value load-bearing for round-trip', () => {
    assertEquals(NAMESPACE_NAME_DELIMITER, '__');
  });
});

describe('unpackNamespaceTools', () => {
  test('expands a namespace into its sub-tools with `<namespace>__` name prefix, dropping the container', () => {
    const tools: ResponsesTool[] = [
      { type: 'function', name: 'top_level', parameters: {}, strict: false },
      {
        type: 'namespace',
        name: 'collab',
        tools: [
          { type: 'function', name: 'spawn_agent', parameters: {}, strict: false },
          { type: 'custom', name: 'exec' },
        ],
      } as unknown as ResponsesTool,
      { type: 'function', name: 'after', parameters: {}, strict: false },
    ];

    const out = unpackNamespaceTools(tools);

    assertEquals(out.length, 4);
    assertEquals(out[0].type, 'function');
    assertEquals((out[0] as { name: string }).name, 'top_level');
    assertEquals(out[1].type, 'function');
    assertEquals((out[1] as { name: string }).name, 'collab__spawn_agent');
    assertEquals(out[2].type, 'custom');
    assertEquals((out[2] as { name: string }).name, 'collab__exec');
    assertEquals(out[3].type, 'function');
    assertEquals((out[3] as { name: string }).name, 'after');
  });

  test('drops an empty namespace and passes non-namespace tools through unchanged', () => {
    const fn: ResponsesTool = { type: 'function', name: 'keep', parameters: {}, strict: false };
    const emptyNs = { type: 'namespace', name: 'ns', tools: [] } as unknown as ResponsesTool;

    const out = unpackNamespaceTools([fn, emptyNs]);

    assertEquals(out.length, 1);
    assertEquals(out[0], fn);
  });

  test('passes malformed namespace (`tools` non-array) through untouched', () => {
    const malformed = { type: 'namespace', name: 'ns' } as unknown as ResponsesTool;

    const out = unpackNamespaceTools([malformed]);

    assertEquals(out.length, 1);
    assertEquals(out[0], malformed);
  });

  test('leaves non-namespace hosted tools untouched (web_search, tool_search, image_generation, programmatic_tool_calling)', () => {
    const tools: ResponsesTool[] = [
      { type: 'web_search' },
      { type: 'image_generation' },
      { type: 'tool_search' },
      { type: 'programmatic_tool_calling' },
    ];

    const out = unpackNamespaceTools(tools);

    assertEquals(out, tools);
  });

  test('preserves sub-tool without a name field (unusual — passes through, unprefixed)', () => {
    const ns = {
      type: 'namespace',
      name: 'ns',
      tools: [{ type: 'web_search' }],
    } as unknown as ResponsesTool;

    const out = unpackNamespaceTools([ns]);

    assertEquals(out.length, 1);
    assertEquals(out[0], { type: 'web_search' });
  });
});

describe('unprefixNamespaceToolCall', () => {
  test('splits `<ns>__<name>` at the LAST delimiter — round-trips namespaces that contain `__`', () => {
    assertEquals(unprefixNamespaceToolCall('collab__spawn_agent'), { namespace: 'collab', name: 'spawn_agent' });
    assertEquals(unprefixNamespaceToolCall('outer__inner__leaf'), { namespace: 'outer__inner', name: 'leaf' });
  });

  test('returns null for names that are not prefixed', () => {
    assertEquals(unprefixNamespaceToolCall('spawn_agent'), null);
    assertEquals(unprefixNamespaceToolCall(''), null);
    assertEquals(unprefixNamespaceToolCall('no_delimiter_here'), null);
  });

  test('returns null for degenerate boundary shapes (leading / trailing / bare delimiter)', () => {
    assertEquals(unprefixNamespaceToolCall('__leaf'), null);
    assertEquals(unprefixNamespaceToolCall('trailing__'), null);
    assertEquals(unprefixNamespaceToolCall('__'), null);
  });
});

describe('flattenToolSearchFamilyTools', () => {
  test('runs the full one-pass desugar: drop tool_search / programmatic_tool_calling, unpack namespace with prefix, strip defer_loading / allowed_callers', () => {
    const tools: ResponsesTool[] = [
      { type: 'function', name: 'keep', parameters: {}, strict: false },
      { type: 'tool_search' },
      { type: 'programmatic_tool_calling' },
      {
        type: 'namespace',
        name: 'collab',
        tools: [
          { type: 'function', name: 'spawn_agent', parameters: {}, strict: false, defer_loading: true },
          { type: 'function', name: 'send_message', parameters: {}, strict: false, allowed_callers: ['programmatic'] },
        ],
      } as unknown as ResponsesTool,
      { type: 'function', name: 'deferred', parameters: {}, strict: false, defer_loading: true, allowed_callers: ['programmatic'] },
      { type: 'custom', name: 'exec' },
      { type: 'web_search' },
    ];

    const out = flattenToolSearchFamilyTools(tools);

    assertEquals(out.length, 6);
    // tool_search and programmatic_tool_calling gone
    assert(!out.some(t => t.type === 'tool_search'));
    assert(!out.some(t => t.type === 'programmatic_tool_calling'));
    // namespace unpacked with prefix
    const collabSpawn = out.find(t => (t as { name?: string }).name === 'collab__spawn_agent') as { defer_loading?: boolean } | undefined;
    assert(collabSpawn !== undefined);
    assertEquals(collabSpawn?.defer_loading, undefined);
    const collabSend = out.find(t => (t as { name?: string }).name === 'collab__send_message') as { allowed_callers?: unknown } | undefined;
    assert(collabSend !== undefined);
    assertEquals(collabSend?.allowed_callers, undefined);
    // Top-level function with defer_loading / allowed_callers has both stripped
    const deferred = out.find(t => (t as { name?: string }).name === 'deferred') as { defer_loading?: boolean; allowed_callers?: unknown } | undefined;
    assert(deferred !== undefined);
    assertEquals(deferred?.defer_loading, undefined);
    assertEquals(deferred?.allowed_callers, undefined);
    // Preserved
    assert(out.some(t => t.type === 'function' && (t as { name: string }).name === 'keep'));
    assert(out.some(t => t.type === 'custom' && (t as { name: string }).name === 'exec'));
    assert(out.some(t => t.type === 'web_search'));
  });

  test('is idempotent on already-flat legacy shape', () => {
    const tools: ResponsesTool[] = [
      { type: 'function', name: 'a', parameters: {}, strict: false },
      { type: 'custom', name: 'b' },
      { type: 'web_search' },
    ];

    const out = flattenToolSearchFamilyTools(tools);
    const twice = flattenToolSearchFamilyTools(out);

    assertEquals(twice, out);
  });
});
