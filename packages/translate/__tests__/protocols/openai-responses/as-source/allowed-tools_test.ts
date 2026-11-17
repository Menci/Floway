import { test } from 'vitest';

import type { SidecarCodec } from '../../../../src/round-trip/codec.ts';
import { TranslateInputException } from '../../../../src/shared/input-error.ts';
import { buildTargetPayloadFor, pairs } from '../../../composition/helpers.ts';
import { createTestSidecarCodec } from '../../../round-trip/sidecar-codec.ts';
import type { CanonicalOpenAIResponsesInputItem, OpenAIResponsesRequestPayloadEx, OpenAIResponsesTool, OpenAIResponsesToolChoice } from '@floway-dev/protocols/openai-responses';
import { assertEquals, assertRejects } from '@floway-dev/test-utils';

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
  test(`${target} preserves declarations or rejects an unrepresentable required subset`, async () => {
    const payload = source({ type: 'allowed_tools', mode: 'required', tools: [{ type: 'custom', name: 'edit' }, { type: 'function', name: 'read' }] });
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
    assertEquals(wire.tool_choice, { type: 'allowed_tools', allowed_tools: { mode: 'required', tools: [{ type: 'function', function: { name: 'edit' } }, { type: 'function', function: { name: 'read' } }] } });

    assertEquals(payload, original);
  });

  test(`${target} request allocates distinct names for function/custom declarations from tool_search_output`, async () => {
    const custom: OpenAIResponsesTool = { type: 'custom', name: 'web_search' };
    const item: CanonicalOpenAIResponsesInputItem = { type: 'tool_search_output', execution: 'client', tools: [custom] };
    const payload: OpenAIResponsesRequestPayloadEx = {
      model: 'model', stream: true,
      tools: [{ type: 'function', name: 'web_search', parameters: { type: 'object' } }],
      input: [item],
    };
    const result = await build(payload);
    const wire = JSON.parse(JSON.stringify(result.target)) as { tools: Array<{ name?: string; function?: { name: string } }> };
    assertEquals(wire.tools.map(tool => tool.function?.name ?? tool.name), ['web_search', 'web_search_2']);
  });

  test(`${target} request disables calling without removing declarations for an empty auto subset`, async () => {
    const result = await build(source({ type: 'allowed_tools', mode: 'auto', tools: [] }));
    const baseline = await build(source('auto'));
    assertEquals(result.target.tools, baseline.target.tools);
    assertEquals(result.target.tool_choice, target === 'chat'
      ? { type: 'allowed_tools', allowed_tools: { mode: 'auto', tools: [] } }
      : { type: 'none' });
  });

}

// The source reader rejects these before any target writer runs, so one target covers them.
test.each([
  ['empty required subset', { type: 'allowed_tools', mode: 'required', tools: [] }],
  ['unknown callable', { type: 'allowed_tools', mode: 'auto', tools: [{ type: 'function', name: 'absent' }] }],
  ['hosted selector without a shim', { type: 'allowed_tools', mode: 'required', tools: [{ type: 'web_search' }] }],
  ['additional selector restriction', { type: 'allowed_tools', mode: 'auto', tools: [{ type: 'function', name: 'read', extension: true }] }],
  ['unknown mode', { type: 'allowed_tools', mode: 'future', tools: [{ type: 'function', name: 'read' }] }],
] as const)('request typed-rejects %s instead of widening allowed_tools', async (_label, choice) => {
  const payload = source(choice as unknown as OpenAIResponsesToolChoice);
  payload.tools!.push({ type: 'custom', name: 'read' });
  await assertRejects(() => buildChat(payload, createTestSidecarCodec()), TranslateInputException, 'allowed_tools');
});

test('rejects namespace selector extensions', async () => {
  const payload = {
    model: 'm', stream: true, input: 'hi',
    tools: [{ type: 'namespace' as const, name: 'files', description: 'files', tools: [{ type: 'function' as const, name: 'read' }] }],
    tool_choice: { type: 'allowed_tools' as const, mode: 'required' as const, tools: [{ type: 'namespace', name: 'files', extension: true }] },
  };
  await assertRejects(() => buildChat(payload as never, createTestSidecarCodec()), TranslateInputException, 'namespace selector extensions');
});

test('Messages expresses a complete required callable set without changing its declarations', async () => {
  const payload = source({
    type: 'allowed_tools', mode: 'required', tools: [
      { type: 'function', name: 'read' }, { type: 'function', name: 'charge' }, { type: 'custom', name: 'edit' },
    ],
  });
  const result = await buildMessages(payload, createTestSidecarCodec());
  const baseline = await buildMessages(source('auto'), createTestSidecarCodec());
  assertEquals(result.target.tools, baseline.target.tools);
  assertEquals(result.target.tool_choice, { type: 'any' });
});

test('Messages rejects an optional single-tool subset rather than forcing that call', async () => {
  await assertRejects(
    () => buildMessages(source({ type: 'allowed_tools', mode: 'auto', tools: [{ type: 'function', name: 'read' }] }), createTestSidecarCodec()),
    TranslateInputException,
    'cannot express an allowed_tools auto subset',
  );
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

test.each([
  ['exact flat declaration', 'web.run', 'web.run', 'web', 'run', true, false],
  ['dotted namespace', 'a.b.run', 'a_b_run', 'a.b', 'run', false, true],
  ['double underscore alias', 'web__run', 'web_run', 'web', 'run', false, true],
] as const)('resolves %s from full callable identities', async (_label, selected, expected, namespace, name, flat, allowed) => {
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

test.each(['chat', 'messages'] as const)('redeclared callables reach %s once with the latest declaration in the first slot', async target => {
  const tools = (description: string): OpenAIResponsesTool[] => [
    { type: 'namespace', name: 'agents', description: '', tools: [{ type: 'function', name: 'wait', parameters: { type: 'object' } }] },
    { type: 'function', name: 'exec', description, parameters: { type: 'object' } },
  ];
  const payload: OpenAIResponsesRequestPayloadEx = {
    model: 'm', stream: true,
    tools: [...tools('first'), { type: 'function', name: 'read', parameters: { type: 'object' } }],
    input: [
      { type: 'additional_tools', role: 'developer', tools: tools('second') },
      { type: 'message', role: 'user', content: 'hi' },
      { type: 'additional_tools', role: 'developer', tools: tools('latest') },
    ],
    tool_choice: { type: 'allowed_tools', mode: 'auto', tools: [{ type: 'namespace', name: 'agents' }] },
  };
  const codec = createTestSidecarCodec();
  if (target === 'chat') {
    const { target: wire } = await buildChat(payload, codec);
    assertEquals(wire.tools?.map(tool => tool.type === 'function' ? [tool.function.name, tool.function.description] : []), [
      ['agents_wait', undefined], ['exec', 'latest'], ['read', undefined],
    ]);
    assertEquals(wire.tool_choice, { type: 'allowed_tools', allowed_tools: { mode: 'auto', tools: [{ type: 'function', function: { name: 'agents_wait' } }] } });
  } else {
    const { target: wire } = await buildMessages({ ...payload, tool_choice: 'auto' }, codec);
    assertEquals(wire.tools?.map(tool => 'name' in tool ? [tool.name, 'description' in tool ? tool.description : undefined] : []), [
      ['agents_wait', undefined], ['exec', 'latest'], ['read', undefined],
    ]);
  }
});
