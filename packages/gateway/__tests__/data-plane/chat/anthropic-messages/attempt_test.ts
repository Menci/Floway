import { expect, test } from 'vitest';

import { countProvider, generateProvider, generateReply, httpReply, messagesFixture, messagesPayload, messagesUpstream, unusedBody } from './fixture.ts';
import { openaiResponsesEgress } from '../../../../src/data-plane/chat/openai-responses/egress.ts';
import { type ChatBodyInput, type ChatBodyOutput, type ChatBodyTargets, createOpenAIResponsesRouteBody } from '../../../../src/data-plane/chat/shared/route-body.ts';
import { openaiResponsesTarget, pickTarget } from '../../../../src/data-plane/chat/shared/target-picker.ts';
import type { GatewayServices } from '../../../../src/data-plane/pipeline/services.ts';
import { Bytes, compose, defineEnding } from '@floway-dev/pipeline';
import { doneFrame, eventFrame } from '@floway-dev/protocols/common';
import type { OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import type { ProviderAnthropicInput, ProviderResponsesInput, ProviderResponsesOutput } from '@floway-dev/provider';

test('generate and countTokens drop the Claude Code beta flag on candidates that strip billing attribution', async () => {
  const seen: (readonly string[])[] = [];
  const fixture = messagesFixture([messagesUpstream({
    flags: ['strip-billing-attribution'],
    pipelines: {
      anthropicMessages: generateProvider((facts, env) => {
        seen.push(facts['request.anthropicBeta']);
        return generateReply(env);
      }),
      anthropicMessagesCountTokens: countProvider(facts => {
        seen.push(facts['request.anthropicBeta']);
        return httpReply(200, Bytes.fromUtf8('{"input_tokens":1}'));
      }),
    },
  })]);
  const headers = { 'anthropic-beta': 'claude-code-20250219, interleaved-thinking-2025-05-14' };
  for (const count of [false, true]) {
    const { response, done } = await fixture.send(messagesPayload(), { count, headers });
    expect(response.status).toBe(200);
    expect(await done).toMatchObject({ ok: true });
  }
  expect(seen).toEqual([['interleaved-thinking-2025-05-14'], ['interleaved-thinking-2025-05-14']]);
});

test('generate lets the target system-to-developer rewrite take precedence over the source system-to-user rewrite', async () => {
  const seen: ProviderResponsesInput[] = [];
  const openaiResponses = compose<ProviderResponsesInput, ProviderResponsesOutput, {}>('test responses provider', {
    stages: [],
    ending: defineEnding<ProviderResponsesInput, ProviderResponsesOutput>({
      name: 'generate',
      request: { needs: ['provider.model', 'request.headers', 'request.payload', 'request.action'] },
      return: { provides: ['response.http', 'response.modelKey', 'response.result', 'response.events'] },
      execute: async (facts, _into, env) => {
        seen.push(facts);
        return {
          ...httpReply(200),
          'response.modelKey': 'responses-model-key',
          'response.result': undefined,
          'response.events': env.createStream({
            label: 'Responses provider',
            async *iterate() {
              yield eventFrame<OpenAIResponsesStreamEventEx>({
                type: 'response.completed', sequence_number: 0,
                response: { id: 'resp_x', object: 'response', model: 'test-model', status: 'completed', output: [], error: null, incomplete_details: null },
              });
              yield doneFrame();
            },
          }),
        };
      },
    }),
  });
  type Api = 'openaiResponses';
  const responses = compose<ChatBodyInput<Api>, ChatBodyOutput<Api>, GatewayServices, ChatBodyTargets<Api>>('test Responses body', {
    stages: [pickTarget(openaiResponsesTarget)],
    targets: { egress: openaiResponsesEgress, messages: unusedBody('anthropicMessages'), chatCompletions: unusedBody('openaiChatCompletions') },
    ending: createOpenAIResponsesRouteBody(error => error),
  });
  const fixture = messagesFixture([messagesUpstream({
    endpoints: { openaiResponses: {} },
    flags: ['rewrite-mid-conv-system-to-user', 'rewrite-system-to-developer'],
    pipelines: { openaiResponses },
  })], { responses });
  const { response, done } = await fixture.send(messagesPayload({
    messages: [{ role: 'user', content: 'hello' }, { role: 'system', content: 'inline instructions' }],
  }), { headers: { 'anthropic-beta': 'context-1m-2025-08-07' } });
  expect(response.status).toBe(200);
  expect(await done).toMatchObject({ ok: true });
  expect(seen[0]?.['request.headers']).toEqual([]);
  expect(seen[0]?.['request.payload'].input).toEqual([
    { type: 'message', role: 'user', content: 'hello' },
    { type: 'message', role: 'developer', content: 'inline instructions' },
  ]);
});

test('countTokens applies generation request transforms before provider dispatch', async () => {
  const seen: ProviderAnthropicInput['request.payload'][] = [];
  const fixture = messagesFixture([messagesUpstream({
    flags: ['strip-billing-attribution', 'disable-reasoning-on-forced-tool-choice', 'rewrite-mid-conv-system-to-user'],
    pipelines: {
      anthropicMessagesCountTokens: countProvider(facts => {
        seen.push(facts['request.payload']);
        return httpReply(200, Bytes.fromUtf8('{"input_tokens":9}'));
      }),
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
    max_tokens: 32, system: 'base rules', messages: [{ role: 'user', content: 'inline rules' }, { role: 'user', content: 'hello' }],
    thinking: { type: 'disabled' }, tool_choice: { type: 'tool', name: 'lookup' },
  }]);
});
