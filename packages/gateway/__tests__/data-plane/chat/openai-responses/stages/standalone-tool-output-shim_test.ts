import { test } from 'vitest';

import { driveResponsesStage } from './drive.ts';
import { standaloneToolOutputShim } from '../../../../../src/data-plane/chat/openai-responses/stages/standalone-tool-output-shim.ts';
import { readHttpBytes } from '../../../../../src/data-plane/pipeline/non-chat.ts';
import type { CanonicalOpenAIResponsesInputItem } from '@floway-dev/protocols/openai-responses';
import type { FlagId } from '@floway-dev/provider';
import { assert, assertEquals } from '@floway-dev/test-utils';

const FLAG = new Set<FlagId>(['openai-responses-standalone-tool-output-shim']);
const lower = (input: CanonicalOpenAIResponsesInputItem[], options?: Parameters<typeof driveResponsesStage>[2]) =>
  driveResponsesStage(standaloneToolOutputShim, { model: 'test-model', input }, options);

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

test('joins text from frozen standalone output after an image', async () => {
  const image = { type: 'input_image' as const, image_url: 'https://example.com/image.png', detail: 'auto' };
  const { seen, done } = await lower([{
    type: 'function_call_output', name: 'context',
    output: [image, { type: 'input_text', text: 'first' }, { type: 'input_text', text: ' second' }],
  }], { enabledFlags: FLAG });
  assertEquals(await done, { ok: true });
  assertEquals(seen?.input, [{
    type: 'message', role: 'user',
    content: [{ type: 'input_text', text: '<external_context>' }, image, { type: 'input_text', text: 'first second</external_context>' }],
  }]);
});

test('returns an input error without running downstream when a standalone output has no name', async () => {
  const { result, seen } = await lower([
    { type: 'message', role: 'user', content: 'hi' },
    { type: 'function_call_output', output: 'orphan' },
  ], { targetApi: 'anthropicMessages' });
  assertEquals(seen, undefined);
  assertEquals(result['response.http'].status, 400);
  const body = JSON.parse((await readHttpBytes(result['response.http'].body)).utf8()) as { error: { param: string } };
  assertEquals(body.error.param, 'input[1].name');
});
