import { expect, test, vi } from 'vitest';

import { disableReasoningOnForcedToolChoice } from '../../../../../src/data-plane/chat/anthropic-messages/stages/disable-reasoning-on-forced-tool-choice.ts';
import { normalizeEmptyToolsToolChoice } from '../../../../../src/data-plane/chat/anthropic-messages/stages/normalize-empty-tools-tool-choice.ts';
import { stripBillingAttribution } from '../../../../../src/data-plane/chat/anthropic-messages/stages/strip-billing-attribution.ts';
import { driveChatStages } from '../../shared/drive-stages.ts';
import { generateReply, messagesFixture, messagesPayload, messagesUpstream } from '../fixture.ts';
import type { Stage } from '@floway-dev/pipeline';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';
import type { FlagId } from '@floway-dev/provider';

const rewriteRequest = async (stage: Stage, payload: AnthropicMessagesPayload, flags: readonly FlagId[]): Promise<AnthropicMessagesPayload> => {
  const { request } = await driveChatStages([stage], {
    'request.anthropicMessages': payload,
    'request.anthropicBeta': [],
    'route.candidate': messagesUpstream({ flags }).candidate,
  }, { key: 'response.anthropicMessages' });
  return request['request.anthropicMessages'];
};

test.each([
  { prompt: 'quota', userAgent: 'claude-cli/2.1.226 (external, cli)' },
  { prompt: 'Hi', userAgent: 'python-httpx/0.28.1' },
  { prompt: 'Hi', userAgent: undefined },
])('forwards a one-token request for $prompt with user agent $userAgent', async ({ prompt, userAgent }) => {
  const upstream = vi.fn(async () => generateReply());
  const fixture = messagesFixture([messagesUpstream({ fetcher: upstream })]);
  const { response, done } = await fixture.send(messagesPayload({ max_tokens: 1, messages: [{ role: 'user', content: prompt }] }), {
    headers: userAgent === undefined ? {} : { 'user-agent': userAgent },
  });
  expect(response.status).toBe(200);
  expect(upstream).toHaveBeenCalledOnce();
  expect(await done).toMatchObject({ ok: true });
});

test('messages forced tool_choice preserves structured-output format while stripping reasoning effort', async () => {
  const schema = { type: 'object', properties: { x: { type: 'string' } }, required: ['x'], additionalProperties: false };
  const format = { type: 'json_schema' as const, schema };
  const result = await rewriteRequest(disableReasoningOnForcedToolChoice, messagesPayload({
    thinking: { type: 'enabled', budget_tokens: 1024 },
    output_config: { effort: 'high', format },
    tool_choice: { type: 'tool', name: 'x' },
  }), ['disable-reasoning-on-forced-tool-choice']);
  expect(result.thinking).toEqual({ type: 'disabled' });
  expect(result.output_config).toEqual({ format });
});

test('messages empty tools rewrites tool_choice to native none', async () => {
  const result = await rewriteRequest(normalizeEmptyToolsToolChoice, messagesPayload({ tools: [], tool_choice: { type: 'auto' } }), ['empty-tools-tool-choice-none']);
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
    const result = await rewriteRequest(normalizeEmptyToolsToolChoice, messagesPayload({ tools, tool_choice }), flags);
    expect(result.tool_choice).toEqual(tool_choice);
  }
});

test('deletes the system field entirely when every array block becomes empty', async () => {
  const result = await rewriteRequest(stripBillingAttribution, messagesPayload({
    system: [
      { type: 'text', text: 'x-anthropic-billing-header: token' },
      { type: 'text', text: 'cch=deadbeef1234;' },
    ],
  }), ['strip-billing-attribution']);
  expect(result).not.toHaveProperty('system');
});
