import { expect, test } from 'vitest';

import { rejectProgramCaller, rejectProgrammaticOpenAIResponsesPayload } from '../../../../src/protocols/openai-responses/as-source/programmatic-tooling.ts';
import { TranslateInputException } from '../../../../src/shared/input-error.ts';
import type { CanonicalOpenAIResponsesInputItem, OpenAIResponsesPayloadEx, OpenAIResponsesTool } from '@floway-dev/protocols/openai-responses';

const programCallerItems = [
  { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{}', status: 'completed', caller: { type: 'program', caller_id: 'call_prog_1' } },
  { type: 'custom_tool_call_output', call_id: 'call_1', output: 'ok', caller: { type: 'program', caller_id: 'call_prog_1' } },
] as const satisfies readonly CanonicalOpenAIResponsesInputItem[];

test.each(programCallerItems)('rejectProgramCaller rejects $type program caller metadata', item => {
  expect(() => rejectProgramCaller(item)).toThrow(TranslateInputException);
});

const payloadCases: Array<{
  name: string;
  payload: Partial<OpenAIResponsesPayloadEx>;
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
  {
    name: 'programmatic inventory caller',
    payload: { input: [{ type: 'tool_search_output', call_id: 'search', execution: 'client', tools: [{ type: 'function', name: 'lookup', parameters: {}, allowed_callers: ['programmatic'] }] }] },
    message: 'Programmatic',
  },
];

test.each(payloadCases)('rejectProgrammaticOpenAIResponsesPayload rejects $name', ({ payload, message }) => {
  expect(() => rejectProgrammaticOpenAIResponsesPayload({ model: 'gpt-test', input: [], ...payload })).toThrow(message);
});
