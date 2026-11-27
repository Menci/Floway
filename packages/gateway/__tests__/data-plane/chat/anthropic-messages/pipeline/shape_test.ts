import { expect, test } from 'vitest';

import { anthropicMessagesBodyStages } from '../../../../../src/data-plane/chat/anthropic-messages/pipeline/body-stages.ts';
import { rewriteAnthropicMessagesRoles } from '../../../../../src/data-plane/chat/anthropic-messages/pipeline/role-compatibility.ts';
import { compose, defineStage } from '../../../../../src/data-plane/chat/pipeline/facts.ts';
import { customCandidate, operationHost, requestFor } from '../../../non-chat/count-tokens/fixtures.ts';
import { asEntry, run } from '@floway-dev/pipeline';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';
import type { FlagId } from '@floway-dev/upstream';

const shape = async (payload: Partial<AnthropicMessagesPayload>, enabledFlags: readonly FlagId[]) => {
  let sent: AnthropicMessagesPayload | undefined;
  const ending = defineStage({
    name: 'capture-anthropic-shape',
    request: { needs: ['anthropicMessages'] },
    return: { provides: ['http'] },
    async execute({ anthropicMessages }) {
      sent = anthropicMessages;
      return { http: null };
    },
  });
  const entry = asEntry(compose('anthropic-shape-test', {
    entry: ['anthropicMessages', 'http', 'model'],
    exit: ['http'],
    stages: [...anthropicMessagesBodyStages, rewriteAnthropicMessagesRoles],
    ending,
  }));
  const model = customCandidate('messages', { anthropicMessages: {} }).model;
  const host = operationHost([], async () => { throw new Error('Shape test reached transport'); });
  const running = run(entry, {
    anthropicMessages: { model: 'm', max_tokens: 32, messages: [], ...payload },
    http: requestFor('/v1/messages', payload).http,
    model: { ...model, enabledFlags },
  }, host.options);
  const answer = await running.result;
  host.controller.abort();
  running.discard(answer);
  await host.settle();
  if (sent === undefined) throw new Error('Expected shaped Anthropic Messages payload');
  return sent;
};

test('removes billing-only system blocks while preserving structured output under forced tool choice', async () => {
  const schema = { type: 'object', properties: { x: { type: 'string' } }, required: ['x'], additionalProperties: false };
  const shaped = await shape({
    system: [{ type: 'text', text: 'x-anthropic-billing-header: token' }, { type: 'text', text: 'cch=deadbeef1234;' }],
    thinking: { type: 'enabled', budget_tokens: 1024 },
    output_config: { effort: 'high', format: { type: 'json_schema', schema } },
    tool_choice: { type: 'tool', name: 'x' },
  }, ['strip-billing-attribution', 'disable-reasoning-on-forced-tool-choice']);
  expect(shaped).not.toHaveProperty('system');
  expect(shaped.thinking).toEqual({ type: 'disabled' });
  expect(shaped.output_config).toEqual({ format: { type: 'json_schema', schema } });
});

test.each([
  { flag: true, tools: [], choice: 'none' },
  { flag: false, tools: [], choice: 'auto' },
  { flag: true, tools: undefined, choice: 'auto' },
  { flag: true, tools: [{ name: 'x', input_schema: { type: 'object' as const } }], choice: 'auto' },
])('only rewrites Anthropic tool choice for enabled, explicitly empty tools', async ({ flag, tools, choice }) => {
  const shaped = await shape({
    ...(tools === undefined ? {} : { tools }), tool_choice: { type: 'auto' },
  }, flag ? ['empty-tools-tool-choice-none'] : []);
  expect(shaped.tool_choice).toEqual({ type: choice });
  expect(shaped.tools).toEqual(tools);
});

test('preserves valid mid-conversation system turns and output-config directives', async () => {
  const directive = { role: 'system' as const, content: [], output_config: { effort: 'high' as const } };
  const rules = { role: 'system' as const, content: 'rules' };
  const invalidSystem = { role: 'system' as const, content: [{ type: 'text' as const, text: 'skills' }] };
  const flags = ['rewrite-disallowed-mid-conv-system-to-user'] as const;
  const user = { role: 'user' as const, content: 'question' };
  const assistant = { role: 'assistant' as const, content: 'answer' };
  const toolResult = { role: 'assistant' as const, content: [{ type: 'web_search_tool_result' as const, tool_use_id: 'srv_1', content: [] }] };
  for (const messages of [[user, rules, assistant], [user, rules], [toolResult, rules]]) {
    expect((await shape({ messages }, flags)).messages).toEqual(messages);
  }
  const invalid = await shape({ messages: [user, directive, invalidSystem, user] }, flags);
  expect(invalid.messages).toEqual([user, directive, { ...invalidSystem, role: 'user' }, user]);
});
