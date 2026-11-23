import { expect, test } from 'vitest';

import { generateReply, messagesFixture, messagesPayload, messagesUpstream, requestPayload, unusedBody } from './fixture.ts';
import { openaiResponsesEgress } from '../../../../src/data-plane/chat/openai-responses/egress.ts';
import { type ChatBodyInput, type ChatBodyOutput, createOpenAIResponsesRouteBody } from '../../../../src/data-plane/chat/shared/route-body.ts';
import { openaiResponsesTarget, pickTarget } from '../../../../src/data-plane/chat/shared/target-picker.ts';
import type { GatewayServices } from '../../../../src/data-plane/pipeline/services.ts';
import type { FetchInit } from '@floway-dev/http';
import { compose } from '@floway-dev/pipeline';
import type { OpenAIResponsesRequestPayloadEx, OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import { jsonResponse, sseResponse } from '@floway-dev/test-utils';

test('generate and countTokens drop the Claude Code beta flag on candidates that strip billing attribution', async () => {
  const seen: (string | null)[] = [];
  const fixture = messagesFixture([messagesUpstream({
    flags: ['strip-billing-attribution'],
    fetcher: async (url, init) => {
      seen.push(new Headers(init.headers).get('anthropic-beta'));
      return new URL(url).pathname.endsWith('/count_tokens') ? jsonResponse({ input_tokens: 1 }) : generateReply();
    },
  })]);
  const headers = { 'anthropic-beta': 'claude-code-20250219, interleaved-thinking-2025-05-14' };
  for (const count of [false, true]) {
    const { response, done } = await fixture.send(messagesPayload(), { count, headers });
    expect(response.status).toBe(200);
    await response.json();
    expect(await done).toMatchObject({ ok: true });
  }
  expect(seen).toEqual(['interleaved-thinking-2025-05-14', 'interleaved-thinking-2025-05-14']);
});

test('generate lets the target system-to-developer rewrite take precedence over the source system-to-user rewrite', async () => {
  const seen: FetchInit[] = [];
  const completion: OpenAIResponsesStreamEventEx = {
    type: 'response.completed', sequence_number: 0,
    response: { id: 'resp_x', object: 'response', model: 'test-model', status: 'completed', output: [], error: null, incomplete_details: null },
  };
  type Api = 'openaiResponses';
  const entry = [
    'request.http', 'request.auth.apiKeyId', 'request.auth.user', 'request.route.upstreamIds', 'request.route.randomizeUpstreams',
    'request.route.runtimeLocation', 'request.action', 'request.openaiResponses', 'route.candidate',
  ] as const;
  const exit = ['response.http', 'response.openaiResponses'] as const;
  const responses = compose<ChatBodyInput<Api> & ChatBodyOutput<Api>, GatewayServices>()('test Responses body', {
    entry, exit,
    stages: [pickTarget(openaiResponsesTarget)],
    targets: { egress: openaiResponsesEgress, messages: unusedBody, chatCompletions: unusedBody },
    ending: createOpenAIResponsesRouteBody(error => error),
  });
  const fixture = messagesFixture([messagesUpstream({
    endpoints: { openaiResponses: {} },
    flags: ['rewrite-mid-conv-system-to-user', 'rewrite-system-to-developer'],
    fetcher: async (_url, init) => {
      seen.push(init);
      return sseResponse(`event: response.completed\ndata: ${JSON.stringify(completion)}\n\n`);
    },
  })], { responses });
  const { response, done } = await fixture.send(messagesPayload({
    messages: [{ role: 'user', content: 'hello' }, { role: 'system', content: 'inline instructions' }],
  }), { headers: { 'anthropic-beta': 'context-1m-2025-08-07' } });
  expect(response.status).toBe(200);
  expect(await done).toMatchObject({ ok: true });
  expect(new Headers(seen[0].headers).has('anthropic-beta')).toBe(false);
  expect(requestPayload<OpenAIResponsesRequestPayloadEx>(seen[0]).input).toEqual([
    { type: 'message', role: 'user', content: 'hello' },
    { type: 'message', role: 'developer', content: 'inline instructions' },
  ]);
});

test('countTokens applies generation request transforms before provider dispatch', async () => {
  const seen: ReturnType<typeof requestPayload>[] = [];
  const fixture = messagesFixture([messagesUpstream({
    flags: ['strip-billing-attribution', 'disable-reasoning-on-forced-tool-choice', 'rewrite-mid-conv-system-to-user'],
    fetcher: async (_url, init) => {
      seen.push(requestPayload(init));
      return jsonResponse({ input_tokens: 9 });
    },
  })]);
  const { response, done } = await fixture.send(messagesPayload({
    system: 'x-anthropic-billing-header: token\ncch=deadbeef1234;\nbase rules',
    messages: [{ role: 'system', content: 'inline rules' }, { role: 'user', content: 'hello' }],
    thinking: { type: 'enabled', budget_tokens: 1024 },
    output_config: { effort: 'high' },
    tool_choice: { type: 'tool', name: 'lookup' },
  }), { count: true });
  expect(await response.text()).toBe('{"input_tokens":9}');
  expect(await done).toMatchObject({ ok: true });
  expect(seen).toEqual([{
    model: 'test-model', max_tokens: 32, system: 'base rules', messages: [{ role: 'user', content: 'inline rules' }, { role: 'user', content: 'hello' }],
    thinking: { type: 'disabled' }, tool_choice: { type: 'tool', name: 'lookup' },
  }]);
});
