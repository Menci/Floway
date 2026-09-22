import { test } from 'vitest';

import { buildTargetRequest as buildMessages } from '../../../src/openai-responses-via-anthropic-messages/request.ts';
import { buildTargetRequest as buildChat } from '../../../src/openai-responses-via-openai-chat-completions/request.ts';
import { TranslatorInputError } from '../../../src/translator-input-error.ts';
import type { OpenAIResponsesRequestPayload, OpenAIResponsesTool, OpenAIResponsesToolChoice } from '@floway-dev/protocols/openai-responses';
import { assertEquals, assertRejects } from '@floway-dev/test-utils';

const source = (tool_choice: OpenAIResponsesToolChoice): OpenAIResponsesRequestPayload => ({
  model: 'model', input: 'Read only.',
  tools: [
    { type: 'function', name: 'read', parameters: { type: 'object', properties: {} } },
    { type: 'function', name: 'charge', parameters: { type: 'object', properties: {} } },
    { type: 'custom', name: 'edit' },
  ],
  tool_choice,
});

for (const target of ['chat', 'messages'] as const) {
  const build = async (payload: OpenAIResponsesRequestPayload) => target === 'chat' ? buildChat(payload) : await buildMessages(payload);
  for (const mode of ['auto', 'required'] as const) {
    test(`${target} request serializes only the allowed function/custom subset and ${mode} mode`, async () => {
      const payload = source({ type: 'allowed_tools', mode, tools: [{ type: 'custom', name: 'edit' }, { type: 'function', name: 'read' }] });
      const original = structuredClone(payload);
      const result = await build(payload);
      const wire = JSON.parse(JSON.stringify(result.target)) as { tools: Array<{ name?: string; function?: { name: string } }>; tool_choice: unknown };
      assertEquals(wire.tools.map(tool => tool.function?.name ?? tool.name), ['read', 'edit']);
      assertEquals(wire.tool_choice, target === 'chat' ? mode : { type: mode === 'required' ? 'any' : 'auto' });
      assertEquals(result.customToolNames, new Set(['edit']));
      assertEquals(payload, original);
    });
  }

  test(`${target} request preserves callable kind when selecting an identically named custom tool`, async () => {
    const payload = source({ type: 'allowed_tools', mode: 'required', tools: [{ type: 'custom', name: 'read' }] });
    payload.tools!.push({ type: 'custom', name: 'read' });
    const result = await build(payload);
    assertEquals(result.target.tools?.length, 1);
    assertEquals(result.customToolNames, new Set(['read']));
  });

  test(`${target} request represents an empty auto subset as no tools`, async () => {
    const result = await build(source({ type: 'allowed_tools', mode: 'auto', tools: [] }));
    assertEquals(result.target.tools, undefined);
    assertEquals(result.target.tool_choice, target === 'chat' ? 'none' : { type: 'none' });
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
