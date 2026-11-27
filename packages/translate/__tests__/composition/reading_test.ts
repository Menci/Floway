import { expect, test } from 'vitest';

import { resolveReading } from '../../src/composition/reading.ts';
import { readAnthropicMessagesRequest } from '../../src/protocols/anthropic-messages/as-source/input-to.ts';
import { readGeminiGenerateContentRequest } from '../../src/protocols/gemini-generate-content/as-source/input-to.ts';
import { readOpenAIChatCompletionsRequest } from '../../src/protocols/openai-chat-completions/as-source/input-to.ts';
import { readOpenAIResponsesRequest } from '../../src/protocols/openai-responses/as-source/input-to.ts';

test('joins parallel server results and the next user message into one client turn', async () => {
  const reading = readAnthropicMessagesRequest({
    model: 'model', max_tokens: 32, messages: [
      { role: 'user', content: 'Q' },
      {
        role: 'assistant', content: [
          { type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'one' } },
          { type: 'server_tool_use', id: 's2', name: 'web_search', input: { query: 'two' } },
          { type: 'web_search_tool_result', tool_use_id: 's1', content: [] },
          { type: 'web_search_tool_result', tool_use_id: 's2', content: [] },
        ],
      },
      { role: 'user', content: 'Next' },
    ],
  });
  expect(await resolveReading(reading, async () => undefined)).toEqual([
    { kind: 'client', items: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'Q' }] }] },
    {
      kind: 'assistant', items: [
        { type: 'function_call', call_id: 's1', name: 'web_search', arguments: '{"query":"one"}' },
        { type: 'function_call', call_id: 's2', name: 'web_search', arguments: '{"query":"two"}' },
      ],
    },
    {
      kind: 'client', items: [
        { type: 'tool_result', call_id: 's1', output: '[]' },
        { type: 'tool_result', call_id: 's2', output: '[]' },
        { type: 'message', role: 'user', content: [{ type: 'text', text: 'Next' }] },
      ],
    },
  ]);
});

test('attaches wire-ordered sourceCallIds on restored assistant turns across all four source protocols', async () => {
  const restored = 'restored-native-turn';
  const resolvedIds = async (reading: Parameters<typeof resolveReading>[0]) => {
    const turns = await resolveReading(reading, async () => restored);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ kind: 'restored', turn: restored });
    return turns[0].kind === 'restored' ? turns[0].sourceCallIds : undefined;
  };

  expect(await resolvedIds(readOpenAIChatCompletionsRequest({
    model: 'model',
    stream: true,
    messages: [{
      role: 'assistant',
      function_call: { name: 'legacy', arguments: '{}' },
      tool_calls: [
        { id: 'tc-1', type: 'function', function: { name: 'a', arguments: '{}' } },
        { id: 'tc-2', type: 'custom', custom: { name: 'b', input: 'x' } },
      ],
    }],
  }))).toEqual([undefined, 'tc-1', 'tc-2']);

  expect(await resolvedIds(readAnthropicMessagesRequest({
    model: 'model',
    max_tokens: 32,
    messages: [
      { role: 'assistant', content: 'plain' },
      {
        role: 'assistant', content: [
          { type: 'tool_use', id: 'tu-1', name: 'a', input: {} },
          { type: 'text', text: 'mid', citations: null },
          { type: 'tool_use', id: 'tu-2', name: 'b', input: {} },
        ],
      },
    ],
  }))).toEqual(['tu-1', 'tu-2']);

  expect(await resolvedIds(readOpenAIResponsesRequest({
    model: 'model',
    stream: true,
    input: [
      { type: 'message', role: 'assistant', content: 'hi' },
      { type: 'custom_tool_call', call_id: 'ctc-1', name: 'a', input: 'x' },
      { type: 'function_call', call_id: 'fc-2', name: 'b', arguments: '{}' },
    ],
  }))).toEqual(['ctc-1', 'fc-2']);

  expect(await resolvedIds(readGeminiGenerateContentRequest({
    model: 'model',
    contents: [{
      role: 'model', parts: [
        { functionCall: { id: 'g-1', name: 'a', args: {} } },
        { functionCall: { name: 'b', args: {} } },
        { functionCall: { id: '', name: 'c', args: {} } },
      ],
    }],
  }))).toEqual(['g-1', undefined, undefined]);
});
