import { test } from 'vitest';

import { lowerOpenAIResponsesStandaloneToolOutputs } from '../../../../src/data-plane/chat/openai-responses/standalone-tool-output-shim.ts';
import { mockChatGatewayCtx } from '../../../test-utils/gateway-ctx.ts';
import { compose, defineStage, move, run } from '@floway-dev/pipeline';
import type { CanonicalOpenAIResponsesInputItem, CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';
import type { ChatTargetApi, FlagId } from '@floway-dev/provider';
import { assert, assertEquals, stubModelCandidate } from '@floway-dev/test-utils';

const FLAG = new Set<FlagId>(['openai-responses-standalone-tool-output-shim']);

const lower = async (
  input: CanonicalOpenAIResponsesInputItem[],
  { enabledFlags = new Set<FlagId>(), targetApi = 'openaiResponses' }: {
    enabledFlags?: ReadonlySet<FlagId>;
    targetApi?: ChatTargetApi;
  } = {},
) => {
  const before = move({ model: 'test-model', input });
  let seen: CanonicalOpenAIResponsesPayload | undefined;
  const candidate = stubModelCandidate();
  const ending = defineStage<Record<string, unknown>, Record<string, unknown>>({
    name: 'captureStandaloneToolOutput',
    return: { provides: ['response.chat.openaiResponses'] },
    execute: async facts => {
      seen = facts['request.chat.openaiResponses'] as CanonicalOpenAIResponsesPayload;
      return move({ ...facts, 'response.chat.openaiResponses': { kind: 'value', body: {} } });
    },
  });
  const pipeline = compose<Record<string, unknown>, Record<string, unknown>>('standaloneToolOutput', [lowerOpenAIResponsesStandaloneToolOutputs, ending]);
  const executed = await run(pipeline, move({
    'request.chat.openaiResponses': before,
    'route.attempt': { candidateId: 0, upstreamId: 'up_test', modelId: 'test-model', flags: [...enabledFlags] },
  }), {
    gateway: mockChatGatewayCtx(),
    resolveAttempt: () => ({ ...candidate, model: { ...candidate.model, endpoints: { [targetApi]: {} } } }),
  });
  await executed.drain();
  const result = executed.facts['response.chat.openaiResponses'] as { status?: number; envelope?: { error: { param: string } } };
  return { before, seen, result };
};

// The item Codex appends after a successful `create_goal` call.
// https://github.com/openai/codex/blob/8011b92bc82d4cc1b6dc3f35c0cd28768c797c97/codex-rs/ext/goal/src/steering.rs#L57-L70
const goalObjective: CanonicalOpenAIResponsesInputItem = {
  type: 'function_call_output',
  id: 'fco_goal',
  name: 'goal_objective',
  namespace: 'agent',
  output: 'Write unit tests for ledger/validate.py',
};

const loweredGoalObjective: CanonicalOpenAIResponsesInputItem = {
  type: 'message',
  role: 'user',
  content: [{ type: 'input_text', text: '<external_goal_objective>Write unit tests for ledger/validate.py</external_goal_objective>' }],
};

const createGoalTurn: CanonicalOpenAIResponsesInputItem[] = [
  { type: 'message', role: 'user', content: 'Write unit tests' },
  { type: 'function_call', call_id: 'call_1', name: 'create_goal', arguments: '{"objective":"Write unit tests for ledger/validate.py"}' },
  { type: 'function_call_output', call_id: 'call_1', output: '{"goal":{"status":"active"}}' },
];

test('lowers standalone outputs in place and keeps paired outputs when the flag is on', async () => {
  const pagePart: CanonicalOpenAIResponsesInputItem = {
    type: 'function_call_output',
    id: 'fco_page',
    call_id: null,
    name: 'codex_apps_open_page',
    namespace: 'agent',
    output: [{ type: 'input_text', text: '{"page_id":null}' }],
  };

  const { seen } = await lower([...createGoalTurn, goalObjective, pagePart], { enabledFlags: FLAG });
  assert(seen !== undefined);

  assertEquals(seen.input, [
    ...createGoalTurn,
    loweredGoalObjective,
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<external_codex_apps_open_page>{"page_id":null}</external_codex_apps_open_page>' }] },
  ]);
});

test('forwards standalone outputs verbatim to a native OpenAI Responses target without the flag', async () => {
  const { before, seen } = await lower([...createGoalTurn, goalObjective]);
  assert(seen !== undefined);
  assert(seen === before);
  assertEquals(seen.input, [...createGoalTurn, goalObjective]);
});

test('returns an input error without running downstream when a standalone output has no name', async () => {
  const { result, seen } = await lower([
    { type: 'message', role: 'user', content: 'hi' },
    { type: 'function_call_output', output: 'orphan' },
  ], { targetApi: 'anthropicMessages' });
  assertEquals(seen, undefined);
  assertEquals(result.status, 400);
  assertEquals(result.envelope?.error.param, 'input[1].name');
});
