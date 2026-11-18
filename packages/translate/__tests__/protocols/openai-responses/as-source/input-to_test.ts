import { expect, test } from 'vitest';

import { routeOpenAIResponsesViaAnthropicMessages, routeOpenAIResponsesViaOpenAIChatCompletions } from '../../../../src/index.ts';
import { readOpenAIResponsesRequest } from '../../../../src/protocols/openai-responses/as-source/input-to.ts';
import { openaiResponsesConversationFromIR } from '../../../../src/protocols/openai-responses/as-target/input-from.ts';
import { createTestSidecarCodec } from '../../../round-trip/sidecar-codec.ts';
import type { OpenAIResponsesRequestPayloadEx } from '@floway-dev/protocols/openai-responses';

const source: OpenAIResponsesRequestPayloadEx = {
  model: 'm', stream: true, input: [{
    type: 'reasoning', summary: [{ type: 'summary_text', text: 'S' }],
    content: [{ type: 'reasoning_text', text: 'C' }], encrypted_content: 'opaque-vendor-data',
  }],
};

test('readable reasoning stays separate in IR beside an opaque encrypted field', async () => {
  const slot = readOpenAIResponsesRequest(source).turns[0];
  expect(slot.toIRInputTurns()).toEqual([{
    kind: 'assistant', items: [{ type: 'reasoning', summary: ['S'], content: ['C'] }],
  }]);
  const trip = await routeOpenAIResponsesViaOpenAIChatCompletions(source, { sidecarCodec: createTestSidecarCodec() });
  if (trip.type !== 'trip') throw new Error(trip.message);
  expect(trip.target.messages).toEqual([{ role: 'assistant', content: null, reasoning_text: 'SC' }]);
  expect(JSON.stringify(trip.target)).not.toContain('opaque-vendor-data');
});

test.each([
  { summary: [''], content: [], expected: [] },
  { summary: [''], content: ['', 'body', ''], expected: [{ type: 'reasoning', content: ['body'] }] },
  { summary: ['', 'summary', ''], content: [''], expected: [{ type: 'reasoning', summary: ['summary'] }] },
])('filters empty reasoning text before producing input IR: %j', ({ summary, content, expected }) => {
  const slot = readOpenAIResponsesRequest({
    model: 'm', stream: true, input: [{
      type: 'reasoning',
      summary: summary.map(text => ({ type: 'summary_text', text })),
      content: content.map(text => ({ type: 'reasoning_text', text })),
      encrypted_content: 'opaque-vendor-data',
    }],
  }).turns[0];
  expect(slot.toIRInputTurns()).toEqual([{ kind: 'assistant', items: expected }]);
});

test('a standalone function call output is rejected as untranslatable', async () => {
  const trip = await routeOpenAIResponsesViaAnthropicMessages({
    model: 'm', stream: true, input: [
      { type: 'message', role: 'user', content: 'hi' },
      { type: 'function_call_output', name: 'goal_objective', namespace: 'agent', output: 'objective' },
    ],
  }, { sidecarCodec: createTestSidecarCodec() });
  expect(trip).toMatchObject({ type: 'input-error', message: 'Cannot translate a function call output without a call_id.' });
});

test('custom result status reaches the Responses wire from the IR failure marker', () => {
  const output = openaiResponsesConversationFromIR([{
    kind: 'client', items: [{ type: 'tool_result', tool_kind: 'custom', call_id: 'c', output: 'failed', is_error: true }],
  }], true);
  expect(output.input).toEqual([{ type: 'custom_tool_call_output', call_id: 'c', output: 'failed', status: 'incomplete' }]);
});

test.each([
  { type: 'future_format', syntax: 'lark', definition: 'start: "ok"' },
])('preserves unrecognized custom format in IR and rejects it at target writing: %j', async format => {
  const payload: OpenAIResponsesRequestPayloadEx = {
    model: 'm', stream: true, input: [],
    tools: [{ type: 'custom', name: 'edit', format }],
  };
  const tool = readOpenAIResponsesRequest(payload).request.tools?.[0];
  expect(tool).toEqual({ type: 'custom', name: 'edit', format: { type: 'unrecognized', value: format } });

  for (const route of [routeOpenAIResponsesViaAnthropicMessages, routeOpenAIResponsesViaOpenAIChatCompletions]) {
    const result = await route(payload, { sidecarCodec: createTestSidecarCodec() });
    expect(result).toMatchObject({ type: 'input-error', message: 'Cannot translate an unrecognized custom tool format.' });
    expect(result).not.toBeInstanceOf(Error);
  }
});

test('an allowed-tools subset does not hide an unrecognized tool declaration', async () => {
  const payload: OpenAIResponsesRequestPayloadEx = {
    model: 'm', stream: true, input: [],
    tools: [
      { type: 'function', name: 'read', parameters: { type: 'object', properties: {} }, strict: false },
      { type: 'custom', name: 'edit', format: { type: 'future_format' } },
    ],
    tool_choice: { type: 'allowed_tools', mode: 'required', tools: [{ type: 'function', name: 'read' }] },
  };
  expect(readOpenAIResponsesRequest(payload).request.tools).toHaveLength(2);
  for (const route of [routeOpenAIResponsesViaAnthropicMessages, routeOpenAIResponsesViaOpenAIChatCompletions]) {
    const result = await route(payload, { sidecarCodec: createTestSidecarCodec() });
    expect(result).toMatchObject({ type: 'input-error', message: 'Cannot translate an unrecognized custom tool format.' });
  }
});
