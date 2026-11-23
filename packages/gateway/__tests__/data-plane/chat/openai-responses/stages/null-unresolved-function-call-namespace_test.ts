import { test } from 'vitest';

import { driveResponsesStage } from './drive.ts';
import { nullUnresolvedFunctionCallNamespace } from '../../../../../src/data-plane/chat/openai-responses/stages/null-unresolved-function-call-namespace.ts';
import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';
import type { FlagId } from '@floway-dev/provider';
import { assert, assertEquals } from '@floway-dev/test-utils';

const tool = (name: string) => ({ type: 'function' as const, name });
const customTool = (name: string) => ({ type: 'custom' as const, name });
const namespace = (name: string, ...members: string[]) => ({ type: 'namespace' as const, name, description: name, tools: members.map(tool) });
const call = (name: string) => ({ type: 'function_call' as const, name, call_id: `call_${name}`, arguments: '{}', status: 'completed' as const });

const rewrite = async (payload: CanonicalOpenAIResponsesPayload, enabledFlags: ReadonlySet<FlagId>) => {
  const { seen, done } = await driveResponsesStage(nullUnresolvedFunctionCallNamespace, payload, { enabledFlags });
  assert(seen !== undefined);
  assertEquals(await done, { ok: true });
  return seen;
};

test('sends an explicit null namespace for unresolved calls to previously declared namespace tools when flagged', async () => {
  const customCall = { type: 'custom_tool_call' as const, name: 'echo_text', call_id: 'call_custom_echo_text', input: 'sample' };
  const functionCallForCustom = call(customCall.name);
  const additionalTools = {
    type: 'additional_tools' as const,
    role: 'developer' as const,
    tools: [
      namespace('first', 'unique', 'ambiguous', 'before_declaration', 'flat_at_top', 'flat_custom_at_top', 'flat_in_history', 'qualified'),
      namespace('second', 'ambiguous'),
      { type: 'namespace' as const, name: 'custom_group', description: 'Custom tools', tools: [customTool(customCall.name)] },
      tool('flat_in_history'),
    ],
  };
  const searchOutput = { type: 'tool_search_output' as const, tools: [namespace('discovered', 'from_search')] };
  const unique = call('unique');
  const ambiguous = call('ambiguous');
  const fromSearch = call('from_search');
  const failedResult = { type: 'function_call_output' as const, call_id: unique.call_id, output: 'unsupported call: unique' };
  const payload: CanonicalOpenAIResponsesPayload = {
    model: 'm',
    tools: [tool('flat_at_top'), customTool('flat_custom_at_top'), namespace('top_level', 'top_level_only')],
    input: [
      call('before_declaration'), additionalTools, unique, failedResult, ambiguous, searchOutput, fromSearch,
      call('unknown'), call('top_level_only'), call('flat_at_top'), call('flat_custom_at_top'), call('flat_in_history'),
      customCall, functionCallForCustom,
      { ...call('qualified'), namespace: 'first' },
    ],
  };

  const flagged = await rewrite(payload, new Set(['openai-responses-null-unresolved-function-call-namespace']));
  const unflagged = await rewrite(payload, new Set());

  assertEquals(unflagged.input, payload.input);
  assertEquals(flagged.input, [
    call('before_declaration'), additionalTools, { ...unique, namespace: null }, failedResult,
    { ...ambiguous, namespace: null }, searchOutput, { ...fromSearch, namespace: null },
    call('unknown'), call('top_level_only'), call('flat_at_top'), call('flat_custom_at_top'), call('flat_in_history'),
    customCall, { ...functionCallForCustom, namespace: null },
    { ...call('qualified'), namespace: 'first' },
  ]);
});
