import { test } from 'vitest';

import { irInputToolsForChoice } from '../../../../src/ir/input/select-tools.ts';
import type { IRInputRequestHeader } from '../../../../src/ir/input/types.ts';
import { buildTargetPayloadFor } from '../../../../src/protocols/composition.ts';
import { requireCallableSelector } from '../../../../src/protocols/openai-responses/as-source/allowed-tools.ts';
import { openaiResponsesRead } from '../../../../src/protocols/openai-responses/as-source/input-to.ts';
import { TranslatorInputError } from '../../../../src/types.ts';
import type { SidecarCodec } from '../../../../src/types.ts';
import { createTestSidecarCodec } from '../../../round-trip/sidecar-codec.ts';
import { pairs } from '../../composition-helpers.ts';
import type { CanonicalOpenAIResponsesInputItem, OpenAIResponsesRequestPayloadEx, OpenAIResponsesTool, OpenAIResponsesToolChoice } from '@floway-dev/protocols/openai-responses';
import { assertEquals, assertRejects, assertThrows } from '@floway-dev/test-utils';
const customToolNamesOf = (request: IRInputRequestHeader): ReadonlySet<string> =>
  new Set((irInputToolsForChoice(request.tools, request.tool_choice) ?? [])
    .flatMap(tool => tool.type === 'custom' ? [tool.name] : []));

const buildChat = async (payload: OpenAIResponsesRequestPayloadEx, codec: SidecarCodec) => {
  const r = openaiResponsesRead(payload);
  return { target: await buildTargetPayloadFor(pairs.responsesToChat[0], pairs.responsesToChat[1], payload, { sidecarCodec: codec }), customToolNames: customToolNamesOf(r.request) };
};
const buildMessages = async (payload: OpenAIResponsesRequestPayloadEx, codec: SidecarCodec, options: { fallbackMaxOutputTokens?: number } = {}) => {
  const r = openaiResponsesRead(payload);
  return { target: await buildTargetPayloadFor(pairs.responsesToMessages[0], pairs.responsesToMessages[1], payload, { sidecarCodec: codec, ...options }), customToolNames: customToolNamesOf(r.request) };
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
        await assertRejects(() => build(payload), TranslatorInputError, 'cannot express an allowed_tools');
        assertEquals(payload, original);
        return;
      }
      const result = await build(payload);
      const baseline = await build({ ...payload, tool_choice: 'auto' });
      assertEquals(result.target.tools, baseline.target.tools);
      const wire = JSON.parse(JSON.stringify(result.target)) as { tools: Array<{ name?: string; function?: { name: string } }>; tool_choice: unknown };
      assertEquals(wire.tools.map(tool => tool.function?.name ?? tool.name), ['read', 'charge', 'edit']);
      assertEquals(wire.tool_choice, { type: 'allowed_tools', allowed_tools: { mode, tools: [{ type: 'function', function: { name: 'edit' } }, { type: 'function', function: { name: 'read' } }] } });
      assertEquals(result.customToolNames, new Set(['edit']));
      assertEquals(payload, original);
    });
  }

  test(`${target} request preserves callable kind when selecting an identically named custom tool`, async () => {
    const payload = source({ type: 'allowed_tools', mode: 'required', tools: [{ type: 'custom', name: 'read' }] });
    payload.tools!.push({ type: 'custom', name: 'read' });
    const result = await build(payload);
    assertEquals(result.target.tools?.length, 4);
    assertEquals(result.customToolNames, new Set(['read']));
  });

  for (const history of ['additional_tools', 'tool_search_output'] as const) {
    test(`${target} request rejects flat function/custom collisions from ${history} before converting calls`, async () => {
      const custom: OpenAIResponsesTool = { type: 'custom', name: 'web_search' };
      const item: CanonicalOpenAIResponsesInputItem = history === 'additional_tools'
        ? { type: 'additional_tools', role: 'developer', tools: [custom] }
        : { type: 'tool_search_output', execution: 'client', tools: [custom] };
      const payload: OpenAIResponsesRequestPayloadEx = {
        model: 'model',
        tools: [{ type: 'function', name: 'web_search', parameters: { type: 'object' } }],
        input: [item],
      };
      await assertRejects(() => build(payload), TranslatorInputError, "distinct callable kinds sharing 'web_search'");
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
    await assertRejects(() => build(payload), TranslatorInputError, 'allowed_tools');
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
    ['colliding callable kinds', { type: 'allowed_tools', mode: 'auto', tools: [{ type: 'function', name: 'read' }, { type: 'custom', name: 'read' }] }],
  ] as const) {
    test(`${target} request typed-rejects ${label} instead of widening allowed_tools`, async () => {
      const payload = source(choice as unknown as OpenAIResponsesToolChoice);
      payload.tools!.push({ type: 'custom', name: 'read' });
      await assertRejects(() => build(payload), TranslatorInputError, 'allowed_tools');
    });
  }
}

test('requireCallableSelector rejects a namespace that is not a string', () => {
  // The selector's namespace is carried into the IR as a string, so a member
  // stating anything else is malformed rather than something to pass through.
  assertEquals(requireCallableSelector({ type: 'function', name: 'read', namespace: 'files' }).namespace, 'files');
  assertThrows(() => requireCallableSelector({ type: 'function', name: 'read', namespace: 42 }), TranslatorInputError);
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
    TranslatorInputError,
    'cannot express an allowed_tools auto subset',
  );
});

test('a dotted selector is only read as a pair when that group is declared', async () => {
  // A flat declaration may spell its name with a dot; that dot is not a group
  // separator, and reading it as one bound the selector to a different callable
  // — or refused a legal request.
  const flat = await buildChat(source({ type: 'function', name: 'a.b' }), createTestSidecarCodec());
  assertEquals(flat.target.tool_choice, { type: 'function', function: { name: 'a.b' } });
});
