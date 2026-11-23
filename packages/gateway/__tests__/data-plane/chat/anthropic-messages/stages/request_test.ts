import { expect, test, vi } from 'vitest';

import { countProvider, generateProvider, generateReply, httpReply, messagesFixture, messagesPayload, messagesUpstream } from '../fixture.ts';
import type { AnthropicMessagesMessage, AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';
import type { FlagId, ProviderAnthropicInput } from '@floway-dev/provider';

const rewriteRequest = async (payload: AnthropicMessagesPayload, flags: readonly FlagId[]): Promise<ProviderAnthropicInput['request.payload']> => {
  const seen: ProviderAnthropicInput[] = [];
  const fixture = messagesFixture([messagesUpstream({
    flags,
    pipelines: {
      anthropicMessagesCountTokens: countProvider(facts => {
        seen.push(facts);
        return httpReply(204);
      }),
    },
  })]);
  const { response, done } = await fixture.send(payload, { count: true });
  expect(response.status).toBe(204);
  expect(await done).toMatchObject({ ok: true });
  expect(seen).toHaveLength(1);
  return seen[0]!['request.payload'];
};

test.each([
  { prompt: 'quota', userAgent: 'claude-cli/2.1.226 (external, cli)' },
  { prompt: 'Hi', userAgent: 'python-httpx/0.28.1' },
  { prompt: 'Hi', userAgent: undefined },
])('forwards a one-token request for $prompt with user agent $userAgent', async ({ prompt, userAgent }) => {
  const upstream = vi.fn(generateReply);
  const fixture = messagesFixture([messagesUpstream({ pipelines: { anthropicMessages: generateProvider((_facts, env) => upstream(env)) } })]);
  const { response, done } = await fixture.send(messagesPayload({ max_tokens: 1, messages: [{ role: 'user', content: prompt }] }), {
    headers: userAgent === undefined ? {} : { 'user-agent': userAgent },
  });
  expect(response.status).toBe(200);
  expect(upstream).toHaveBeenCalledOnce();
  expect(await done).toMatchObject({ ok: true });
});

test('rewrites only content-bearing system messages in disallowed Anthropic positions', async () => {
  const directive = { role: 'system' as const, content: [], output_config: { effort: 'high' as const } };
  const invalidContent = [{ type: 'text' as const, text: 'skills' }];
  const messages: AnthropicMessagesMessage[] = [
    { role: 'user', content: 'AGENTS' }, directive, { role: 'system', content: invalidContent }, { role: 'user', content: 'current question' },
  ];
  const result = await rewriteRequest(messagesPayload({ messages }), ['rewrite-disallowed-mid-conv-system-to-user']);
  expect(result.messages).toEqual([messages[0], directive, { role: 'user', content: invalidContent }, messages[3]]);
});

test('preserves valid content-bearing system turn boundaries', async () => {
  const cases: AnthropicMessagesMessage[][] = [
    [{ role: 'user', content: 'question' }, { role: 'system', content: 'rules' }, { role: 'assistant', content: 'answer' }],
    [{ role: 'user', content: 'question' }, { role: 'system', content: 'rules' }],
    [
      { role: 'assistant', content: [{ type: 'web_search_tool_result', tool_use_id: 'srv_1', content: [] }] },
      { role: 'system', content: 'updated context' },
    ],
  ];
  for (const messages of cases) {
    const result = await rewriteRequest(messagesPayload({ messages }), ['rewrite-disallowed-mid-conv-system-to-user']);
    expect(result.messages).toEqual(messages);
  }
});

test('messages forced tool_choice preserves structured-output format while stripping reasoning effort', async () => {
  const schema = { type: 'object', properties: { x: { type: 'string' } }, required: ['x'], additionalProperties: false };
  const format = { type: 'json_schema' as const, schema };
  const result = await rewriteRequest(messagesPayload({
    thinking: { type: 'enabled', budget_tokens: 1024 },
    output_config: { effort: 'high', format },
    tool_choice: { type: 'tool', name: 'x' },
  }), ['disable-reasoning-on-forced-tool-choice']);
  expect(result.thinking).toEqual({ type: 'disabled' });
  expect(result.output_config).toEqual({ format });
});

test('messages empty tools rewrites tool_choice to native none', async () => {
  const result = await rewriteRequest(messagesPayload({ tools: [], tool_choice: { type: 'auto' } }), ['empty-tools-tool-choice-none']);
  expect(result.tools).toEqual([]);
  expect(result.tool_choice).toEqual({ type: 'none' });
});

test('messages rewrite requires the flag and an explicit empty array', async () => {
  const tool_choice = { type: 'auto' as const };
  const cases = [
    { tools: [], flags: [] },
    { tools: undefined, flags: ['empty-tools-tool-choice-none'] as const },
    { tools: [{ name: 'x', description: 'x', input_schema: { type: 'object' as const } }], flags: ['empty-tools-tool-choice-none'] as const },
  ];
  for (const { tools, flags } of cases) {
    const result = await rewriteRequest(messagesPayload({ tools, tool_choice }), flags);
    expect(result.tool_choice).toEqual(tool_choice);
  }
});

test('deletes the system field entirely when every array block becomes empty', async () => {
  const result = await rewriteRequest(messagesPayload({
    system: [
      { type: 'text', text: 'x-anthropic-billing-header: token' },
      { type: 'text', text: 'cch=deadbeef1234;' },
    ],
  }), ['strip-billing-attribution']);
  expect(result).not.toHaveProperty('system');
});
