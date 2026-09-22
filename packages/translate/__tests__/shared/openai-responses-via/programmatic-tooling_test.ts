import { expect, test } from 'vitest';

import { rejectProgramCaller, rejectProgrammaticOpenAIResponsesPayload } from '../../../src/shared/openai-responses-via/programmatic-tooling.ts';
import type { OpenAIResponsesInputItem, OpenAIResponsesPayload, OpenAIResponsesTool } from '@floway-dev/protocols/openai-responses';

const programCallerItems = [
  { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{}', status: 'completed', caller: { type: 'program', caller_id: 'call_prog_1' } },
  { type: 'function_call_output', call_id: 'call_1', output: 'ok', caller: { type: 'program', caller_id: 'call_prog_1' } },
  { type: 'custom_tool_call', call_id: 'call_1', name: 'exec', input: 'run', caller: { type: 'program', caller_id: 'call_prog_1' } },
  { type: 'custom_tool_call_output', call_id: 'call_1', output: 'ok', caller: { type: 'program', caller_id: 'call_prog_1' } },
] as const satisfies readonly OpenAIResponsesInputItem[];

test.each(programCallerItems)('rejectProgramCaller rejects $type program caller metadata', item => {
  expect(() => rejectProgramCaller(item)).toThrow('program caller');
});

const payloadCases: Array<{
  name: string;
  payload: Partial<OpenAIResponsesPayload>;
  message: string;
}> = [
  {
    name: 'programmatic tool',
    payload: { tools: [{ type: 'programmatic_tool_calling' }] },
    message: 'Programmatic',
  },
  {
    name: 'programmatic allowed caller',
    payload: { tools: [{ type: 'function', name: 'lookup', parameters: {}, strict: true, allowed_callers: ['programmatic'] }] },
    message: 'Programmatic',
  },
  {
    name: 'programmatic tool choice',
    payload: { tool_choice: { type: 'programmatic_tool_calling' } },
    message: 'Programmatic',
  },
  {
    name: 'deferred function tool',
    payload: { tools: [{ type: 'function', name: 'lookup', parameters: {}, strict: true, defer_loading: true }] },
    message: 'Deferred',
  },
  {
    name: 'deferred custom tool',
    payload: { tools: [{ type: 'custom', name: 'exec', defer_loading: true }] },
    message: 'Deferred',
  },
  {
    name: 'nested namespace programmatic caller',
    payload: {
      tools: [{
        type: 'namespace',
        name: 'ops',
        description: 'ops',
        tools: [{ type: 'custom', name: 'exec', allowed_callers: ['programmatic'] }],
      } as unknown as OpenAIResponsesTool],
    },
    message: 'Programmatic',
  },
];

const targetPayloadCases = ['OpenAI Chat Completions', 'Anthropic Messages'].flatMap(target =>
  payloadCases.map(testCase => ({ target, ...testCase })));

test.each(targetPayloadCases)('rejectProgrammaticOpenAIResponsesPayload rejects $name for $target', ({ target, payload, message }) => {
  expect(() => rejectProgrammaticOpenAIResponsesPayload({ model: 'gpt-test', input: [], ...payload }, target)).toThrow(message);
});

test('rejectProgramCaller accepts ordinary callers', () => {
  expect(() => rejectProgramCaller({ type: 'function_call_output', call_id: 'call_1', output: 'ok' })).not.toThrow();
});

test('rejectProgrammaticOpenAIResponsesPayload accepts ordinary function tooling', () => {
  expect(() => rejectProgrammaticOpenAIResponsesPayload({
    model: 'gpt-test',
    input: [],
    tools: [{ type: 'function', name: 'lookup', parameters: {}, strict: true }],
  }, 'Anthropic Messages')).not.toThrow();
});
