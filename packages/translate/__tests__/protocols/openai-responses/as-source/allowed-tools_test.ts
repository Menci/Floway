import { test } from 'vitest';

import { requireCallableSelector } from '../../../../src/protocols/openai-responses/as-source/allowed-tools.ts';
import type { SidecarCodec } from '../../../../src/round-trip/codec.ts';
import { TranslateInputException } from '../../../../src/shared/input-error.ts';
import { buildTargetPayloadFor, pairs } from '../../../composition/helpers.ts';
import { createTestSidecarCodec } from '../../../round-trip/sidecar-codec.ts';
import type { CanonicalOpenAIResponsesInputItem, OpenAIResponsesRequestPayloadEx, OpenAIResponsesTool, OpenAIResponsesToolChoice } from '@floway-dev/protocols/openai-responses';
import { assertEquals, assertRejects, assertThrows } from '@floway-dev/test-utils';

const buildChat = async (payload: OpenAIResponsesRequestPayloadEx, codec: SidecarCodec) => {
  return { target: await buildTargetPayloadFor(pairs.responsesToChat[0], pairs.responsesToChat[1], payload, { sidecarCodec: codec }) };
};
const buildMessages = async (payload: OpenAIResponsesRequestPayloadEx, codec: SidecarCodec, options: { fallbackMaxOutputTokens?: number } = {}) => {
  return { target: await buildTargetPayloadFor(pairs.responsesToMessages[0], pairs.responsesToMessages[1], payload, { sidecarCodec: codec, ...options }) };
};

const source = (tool_choice: OpenAIResponsesToolChoice): OpenAIResponsesRequestPayloadEx => ({
  model: 'model', stream: true, input: 'Read only.',
  tools: [
    { type: 'function', name: 'read', parameters: { type: 'object', properties: {} } },
    { type: 'function', name: 'charge', parameters: { type: 'object', properties: {} } },
    { type: 'custom', name: 'edit' },
  ],
  tool_choice,
});

for (const target of ['chat', 'messages'] as const) {
  const build = async (payload: OpenAIResponsesRequestPayloadEx) => target === 'chat'
    ? await buildChat(payload, createTestSidecarCodec())
    : await buildMessages(payload, createTestSidecarCodec(), {
        fallbackMaxOutputTokens: undefined,
      });
  for (const mode of ['auto', 'required'] as const) {
    test(`${target} preserves declarations or rejects an unrepresentable ${mode} subset`, async () => {
      const payload = source({ type: 'allowed_tools', mode, tools: [{ type: 'custom', name: 'edit' }, { type: 'function', name: 'read' }] });
      const original = structuredClone(payload);
      if (target === 'messages') {
        await assertRejects(() => build(payload), TranslateInputException, 'cannot express an allowed_tools');
        assertEquals(payload, original);
        return;
      }
      const result = await build(payload);
      const baseline = await build({ ...payload, tool_choice: 'auto' });
      assertEquals(result.target.tools, baseline.target.tools);
      const wire = JSON.parse(JSON.stringify(result.target)) as { tools: Array<{ name?: string; function?: { name: string } }>; tool_choice: unknown };
      assertEquals(wire.tools.map(tool => tool.function?.name ?? tool.name), ['read', 'charge', 'edit']);
      assertEquals(wire.tool_choice, { type: 'allowed_tools', allowed_tools: { mode, tools: [{ type: 'function', function: { name: 'edit' } }, { type: 'function', function: { name: 'read' } }] } });

      assertEquals(payload, original);
    });
  }

  test(`${target} request preserves callable kind when selecting an identically named custom tool`, async () => {
    const payload = source({ type: 'allowed_tools', mode: 'required', tools: [{ type: 'custom', name: 'read' }] });
    payload.tools!.push({ type: 'custom', name: 'read' });
    const result = await build(payload);
    assertEquals(result.target.tools?.length, 4);

  });

  for (const history of ['additional_tools', 'tool_search_output'] as const) {
    test(`${target} request allocates distinct names for function/custom declarations from ${history}`, async () => {
      const custom: OpenAIResponsesTool = { type: 'custom', name: 'web_search' };
      const item: CanonicalOpenAIResponsesInputItem = history === 'additional_tools'
        ? { type: 'additional_tools', role: 'developer', tools: [custom] }
        : { type: 'tool_search_output', execution: 'client', tools: [custom] };
      const payload: OpenAIResponsesRequestPayloadEx = {
        model: 'model', stream: true,
        tools: [{ type: 'function', name: 'web_search', parameters: { type: 'object' } }],
        input: [item],
      };
      const result = await build(payload);
      const wire = JSON.parse(JSON.stringify(result.target)) as { tools: Array<{ name?: string; function?: { name: string } }> };
      assertEquals(wire.tools.map(tool => tool.function?.name ?? tool.name), ['web_search', 'web_search_2']);
    });
  }

  test(`${target} request disables calling without removing declarations for an empty auto subset`, async () => {
    const result = await build(source({ type: 'allowed_tools', mode: 'auto', tools: [] }));
    const baseline = await build(source('auto'));
    assertEquals(result.target.tools, baseline.target.tools);
    assertEquals(result.target.tool_choice, target === 'chat'
      ? { type: 'allowed_tools', allowed_tools: { mode: 'auto', tools: [] } }
      : { type: 'none' });
  });

  test(`${target} request rejects a flat selector that would erase a declaration namespace`, async () => {
    const payload = source({ type: 'allowed_tools', mode: 'auto', tools: [{ type: 'function', name: 'read' }] });
    payload.tools![0] = { ...payload.tools![0], namespace: 'files' } as unknown as OpenAIResponsesTool;
    await assertRejects(() => build(payload), TranslateInputException, 'allowed_tools');
  });

  for (const [label, choice] of [
    ['empty required subset', { type: 'allowed_tools', mode: 'required', tools: [] }],
    ['unknown callable', { type: 'allowed_tools', mode: 'auto', tools: [{ type: 'function', name: 'absent' }] }],
    ['hosted selector without a shim', { type: 'allowed_tools', mode: 'required', tools: [{ type: 'web_search' }] }],
    ['MCP selector', { type: 'allowed_tools', mode: 'auto', tools: [{ type: 'mcp', server_label: 'remote' }] }],
    ['unflattened namespace selector', { type: 'allowed_tools', mode: 'auto', tools: [{ type: 'function', namespace: 'files', name: 'read' }] }],
    ['additional selector restriction', { type: 'allowed_tools', mode: 'auto', tools: [{ type: 'function', name: 'read', extension: true }] }],
    ['unknown mode', { type: 'allowed_tools', mode: 'future', tools: [{ type: 'function', name: 'read' }] }],
    ['malformed tools array', { type: 'allowed_tools', mode: 'auto', tools: null }],
    ['malformed selector', { type: 'allowed_tools', mode: 'auto', tools: [null] }],
  ] as const) {
    test(`${target} request typed-rejects ${label} instead of widening allowed_tools`, async () => {
      const payload = source(choice as unknown as OpenAIResponsesToolChoice);
      payload.tools!.push({ type: 'custom', name: 'read' });
      await assertRejects(() => build(payload), TranslateInputException, 'allowed_tools');
    });
  }
}

test('requireCallableSelector rejects a namespace that is not a string', () => {

  assertEquals(requireCallableSelector({ type: 'function', name: 'read', namespace: 'files' }).namespace, 'files');
  assertThrows(() => requireCallableSelector({ type: 'function', name: 'read', namespace: 42 }), TranslateInputException);
});

test.each(['auto', 'required'] as const)('Messages expresses a complete %s callable set without changing its declarations', async mode => {
  const payload = source({
    type: 'allowed_tools', mode, tools: [
      { type: 'function', name: 'read' }, { type: 'function', name: 'charge' }, { type: 'custom', name: 'edit' },
    ],
  });
  const result = await buildMessages(payload, createTestSidecarCodec());
  const baseline = await buildMessages(source('auto'), createTestSidecarCodec());
  assertEquals(result.target.tools, baseline.target.tools);
  assertEquals(result.target.tool_choice, { type: mode === 'auto' ? 'auto' : 'any' });
});

test('Messages rejects an optional single-tool subset rather than forcing that call', async () => {
  await assertRejects(
    () => buildMessages(source({ type: 'allowed_tools', mode: 'auto', tools: [{ type: 'function', name: 'read' }] }), createTestSidecarCodec()),
    TranslateInputException,
    'cannot express an allowed_tools auto subset',
  );
});

test('a dotted selector is only read as a pair when that group is declared', async () => {
  // A dot in a flat declaration belongs to its name; treating it as a namespace separator selects a different callable.
  const flat = await buildChat(source({ type: 'function', name: 'a.b' }), createTestSidecarCodec());
  assertEquals(flat.target.tool_choice, { type: 'function', function: { name: 'a.b' } });
});

test.each(['chat', 'messages'] as const)('preserves declarations and selects only the namespaced custom callable on %s', async target => {
  const payload: OpenAIResponsesRequestPayloadEx = {
    model: 'm', stream: true, input: 'hi', tools: [{
      type: 'namespace', name: 'files', description: '', tools: [
        { type: 'function', name: 'edit', parameters: { type: 'object', properties: {} } },
        { type: 'custom', name: 'edit' },
      ],
    }],
    tool_choice: { type: 'allowed_tools', mode: 'required', tools: [{ type: 'custom', namespace: 'files', name: 'edit' }] },
  };
  const codec = createTestSidecarCodec();
  if (target === 'chat') {
    const result = await buildChat(payload, codec);
    const baseline = await buildChat({ ...payload, tool_choice: 'auto' }, codec);
    assertEquals(result.target.tools, baseline.target.tools);
    assertEquals(result.target.tools?.map(tool => tool.type === 'function' ? tool.function.name : tool.custom.name), ['files_edit', 'files_edit_2']);
    assertEquals(result.target.tool_choice, { type: 'allowed_tools', allowed_tools: { mode: 'required', tools: [{ type: 'function', function: { name: 'files_edit_2' } }] } });
  } else {
    const result = await buildMessages(payload, codec);
    const baseline = await buildMessages({ ...payload, tool_choice: 'auto' }, codec);
    assertEquals(result.target.tools, baseline.target.tools);
    assertEquals(result.target.tools?.flatMap(tool => 'name' in tool ? [tool.name] : []), ['files_edit', 'files_edit_2']);
    assertEquals(result.target.tool_choice, { type: 'tool', name: 'files_edit_2' });
  }
});

for (const allowed of [false, true]) {
  test.each([
    ['exact flat declaration', 'web.run', 'web.run', 'web', 'run', true],
    ['dotted namespace', 'a.b.run', 'a_b_run', 'a.b', 'run', false],
    ['double underscore alias', 'web__run', 'web_run', 'web', 'run', false],
  ] as const)(`resolves %s from full callable identities (allowed_tools=${allowed})`, async (_label, selected, expected, namespace, name, flat) => {
    const payload: OpenAIResponsesRequestPayloadEx = {
      model: 'm', stream: true, input: 'hi',
      tools: [
        ...(flat ? [{ type: 'function' as const, name: selected, parameters: { type: 'object', properties: {} } }] : []),
        { type: 'namespace', name: namespace, description: '', tools: [{ type: 'function', name, parameters: { type: 'object', properties: {} } }] },
      ],
      tool_choice: allowed
        ? { type: 'allowed_tools', mode: 'required', tools: [{ type: 'function', name: selected }] }
        : { type: 'function', name: selected },
    };
    const result = await buildChat(payload, createTestSidecarCodec());
    const baseline = await buildChat({ ...payload, tool_choice: 'auto' }, createTestSidecarCodec());
    assertEquals(result.target.tools, baseline.target.tools);
    assertEquals(result.target.tool_choice, allowed
      ? { type: 'allowed_tools', allowed_tools: { mode: 'required', tools: [{ type: 'function', function: { name: expected } }] } }
      : { type: 'function', function: { name: expected } });
  });
}
