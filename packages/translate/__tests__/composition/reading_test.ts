import { expect, test } from 'vitest';

import { resolveReading } from '../../src/composition/reading.ts';
import { anthropicMessagesRead } from '../../src/protocols/anthropic-messages/as-source/input-to.ts';

test('joins parallel server results and the next user message into one client turn', async () => {
  const reading = anthropicMessagesRead({
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
    { kind: 'client', items: [{ type: 'message', content: [{ type: 'text', text: 'Q' }] }] },
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
        { type: 'message', content: [{ type: 'text', text: 'Next' }] },
      ],
    },
  ]);
});

test('keeps prompt and restored assistant boundaries while joining client pieces', async () => {
  const reading = anthropicMessagesRead({
    model: 'model', max_tokens: 32, system: 'Rules', messages: [
      { role: 'user', content: 'Before' },
      { role: 'assistant', content: 'Native' },
      { role: 'user', content: 'After' },
    ],
  });
  expect((await resolveReading(reading, async () => 'restored')).map(turn => turn.kind))
    .toEqual(['client', 'client', 'resolved', 'client']);
});
