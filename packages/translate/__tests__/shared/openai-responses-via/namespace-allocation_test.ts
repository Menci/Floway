import { test, vi } from 'vitest';

import { flattenNamespaceTools } from '../../../src/shared/openai-responses-via/namespace-tools.ts';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesTool } from '@floway-dev/protocols/openai-responses';
import { assert, assertEquals } from '@floway-dev/test-utils';

const functionTool = (name: string): Extract<OpenAIResponsesTool, { type: 'function' }> => ({ type: 'function', name, parameters: { type: 'object' } });

for (const [namespace, reservePreferred] of [['n'.repeat(64), false], ['n'.repeat(59), true]] as const) {
  test(`callable projection bounds collision lookups for ${namespace.length}-character namespaces`, () => {
    const count = 1000;
    const children = Array.from({ length: count }, (_, index) => functionTool(String(index).padStart(4, '0')));
    const reserved = reservePreferred ? children.map(child => functionTool(`${namespace}_${'name' in child ? child.name : ''}`)) : [];
    const request: CanonicalOpenAIResponsesPayload = { model: 'm', input: [], tools: [...reserved, { type: 'namespace', name: namespace, description: '', tools: children }] };
    let call: ReturnType<typeof flattenNamespaceTools>;
    const has = vi.spyOn(Set.prototype, 'has');
    let checks = 0;
    try {
      call = flattenNamespaceTools(request);
      checks = has.mock.calls.length;
    } finally { has.mockRestore(); }
    const names = call.payload.tools!.slice(reserved.length).map(tool => 'name' in tool ? tool.name : '');
    assertEquals(names.length, count);
    assertEquals(new Set(names).size, count);
    assert(names.every(name => typeof name === 'string' && name.length <= 64));
    assert(checks >= count, 'instrument must observe collision membership checks');
    assert(checks <= 2 * count + reserved.length, `expected bounded lookup count, observed ${checks}`);
  });
}

test('callable projection preserves suffix ordering across digit widths, invalid characters and duplicates', () => {
  const namespace = 'n'.repeat(59);
  const prefix = `${namespace}_`;
  const children = ['aaaa', 'aaab', 'aaac', 'a', 'aa', 'aaaa'];
  const reserved = [...children.slice(0, -1).map(name => `${prefix}${name}`), ...Array.from({ length: 8 }, (_, i) => `${prefix}aa_${i + 2}`), `${prefix}a_10`, `${prefix}a_12`];
  const call = flattenNamespaceTools({ model: 'm', input: [], tools: [...reserved.map(functionTool), { type: 'namespace', name: namespace, description: '', tools: children.map(functionTool) }, { type: 'namespace', name: 'bad.ns', description: '', tools: [functionTool('bad/name')] }] });
  assertEquals(call.payload.tools?.slice(reserved.length).map(tool => 'name' in tool ? tool.name : null), [`${prefix}a_11`, `${prefix}a_13`, `${prefix}a_14`, `${prefix}a_2`, `${prefix}a_15`, `${prefix}a_11`, 'bad_ns_bad_name']);
});

test('callable projection bounds sanitized flat-name prefixes for a shared long namespace', () => {
  const namespace = 'n'.repeat(4096);
  const count = 32;
  const request: CanonicalOpenAIResponsesPayload = { model: 'm', input: [], tools: [{ type: 'namespace', name: namespace, description: '', tools: Array.from({ length: count }, (_, index) => functionTool(`tool${index}`)) }] };
  let call: ReturnType<typeof flattenNamespaceTools>;
  const replacements = vi.spyOn(String.prototype, 'replaceAll');
  let lengths: number[] = [];
  try {
    call = flattenNamespaceTools(request);
    lengths = replacements.mock.contexts.map(context => String(context).length);
  } finally {
    replacements.mockRestore();
  }
  assert(lengths.length > 0, 'instrument must observe the allocator sanitizing names');
  assert(Math.max(...lengths) <= 64, `allocator scanned an unbounded prefix: ${Math.max(...lengths)}`);
  assertEquals(new Set(call.payload.tools!.map(tool => 'name' in tool ? tool.name : null)).size, count);
});
