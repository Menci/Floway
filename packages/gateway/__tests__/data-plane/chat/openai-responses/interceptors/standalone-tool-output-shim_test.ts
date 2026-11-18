import { test } from 'vitest';

import { withOpenAIResponsesStandaloneToolOutputShim } from '../../../../../src/data-plane/chat/openai-responses/interceptors/standalone-tool-output-shim.ts';
import type { OpenAIResponsesInvocation } from '../../../../../src/data-plane/chat/openai-responses/interceptors/types.ts';
import { mockChatGatewayCtx } from '../../../../test-utils/gateway-ctx.ts';
import { doneFrame } from '@floway-dev/protocols/common';
import type { CanonicalOpenAIResponsesInputItem } from '@floway-dev/protocols/openai-responses';
import { decodeResponseBody, eventResult, type FlagId } from '@floway-dev/provider';
import { assert, assertEquals, stubModelCandidate, testTelemetryModelIdentity } from '@floway-dev/test-utils';

const gatewayCtx = mockChatGatewayCtx();
const okEvents = () => Promise.resolve(eventResult((async function* () { yield doneFrame(); })(), testTelemetryModelIdentity));

const FLAG = new Set<FlagId>(['openai-responses-standalone-tool-output-shim']);

const lower = async (
  input: CanonicalOpenAIResponsesInputItem[],
  { enabledFlags = new Set<FlagId>(), targetApi = 'openaiResponses' }: {
    enabledFlags?: ReadonlySet<FlagId>;
    targetApi?: OpenAIResponsesInvocation['targetApi'];
  } = {},
) => {
  const invocation: OpenAIResponsesInvocation = {
    payload: { model: 'test-model', input },
    candidate: stubModelCandidate({ enabledFlags }),
    targetApi,
    headers: new Headers(),
    action: 'generate',
  };
  const before = invocation.payload;
  let seen: OpenAIResponsesInvocation['payload'] | undefined;
  const result = await withOpenAIResponsesStandaloneToolOutputShim(invocation, gatewayCtx, () => {
    seen = invocation.payload;
    return okEvents();
  });
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
  assert(result.type === 'api-error');
  assertEquals(result.http.status, 400);
  const body = JSON.parse(decodeResponseBody(result.body)) as { error: { message: string; param: string } };
  assertEquals(body.error.message, 'A function call output without a call_id requires a name.');
  assertEquals(body.error.param, 'input[1].name');
});
