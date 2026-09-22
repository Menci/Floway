import { expect, test } from 'vitest';

import { canonicalizeOpenAIResponsesPayload } from '../../../src/canonicalize-openai-responses-payload.ts';
import { buildTargetRequest as messagesRequest } from '../../../src/openai-responses-via-anthropic-messages/request.ts';
import { buildTargetRequest as chatRequest } from '../../../src/openai-responses-via-openai-chat-completions/request.ts';
import { flattenNamespaceTools, restoreNamespaceEvents } from '../../../src/shared/openai-responses-via/namespace-tools.ts';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIResponsesRequestPayload, OpenAIResponsesStreamEvent } from '@floway-dev/protocols/openai-responses';

const payload = (): OpenAIResponsesRequestPayload => ({
  model: 'm',
  tools: [
    { type: 'function', name: 'agents_spawn' },
    {
      type: 'namespace', name: 'agents', description: '', tools: [
        { type: 'function', name: 'spawn', parameters: { type: 'object' } },
        { type: 'function', name: 'wait', parameters: { type: 'object' } },
        { type: 'custom', name: 'audit' },
      ],
    },
  ],
  input: [{ type: 'function_call', namespace: 'agents', name: 'wait', call_id: 'old', arguments: '{}', status: 'completed' }],
  tool_choice: { type: 'allowed_tools', mode: 'required', tools: [{ type: 'function', namespace: 'agents', name: 'spawn' }] },
});

test('both targets preserve namespace subsets and excluded replay identities', async () => {
  const source = payload();
  const chat = chatRequest(source);
  const messages = await messagesRequest(source);
  expect(chat.target.tools?.map(tool => tool.type === 'function' ? tool.function.name : '')).toEqual(['agents_spawn_2']);
  expect(messages.target.tools?.map(tool => tool.name)).toEqual(['agents_spawn_2']);
  expect(chat.target.messages[0].tool_calls?.[0].function.name).toBe('agents_wait');
  expect(messages.target.messages[0].content).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'tool_use', name: 'agents_wait' })]));
  expect(chat.target.tool_choice).toBe('required');
  expect(messages.target.tool_choice).toEqual({ type: 'any' });
});

test('expands namespace selectors and includes deferred declarations on both targets', async () => {
  const source = payload();
  source.tool_choice = { type: 'allowed_tools', mode: 'auto', tools: [{ type: 'namespace', name: 'agents' }] };
  source.input = [{ type: 'additional_tools', role: 'developer', tools: source.tools! }];
  source.tools = undefined;
  expect(chatRequest(source).target.tools).toHaveLength(3);
  expect((await messagesRequest(source)).target.tools).toHaveLength(3);
});

test('history-only namespace calls reserve names without inventing declarations', async () => {
  const source = payload();
  source.tools = undefined;
  source.tool_choice = undefined;
  const chat = chatRequest(source);
  const messages = await messagesRequest(source);
  expect(chat.target.tools).toBeUndefined();
  expect(messages.target.tools).toBeUndefined();
  expect(chat.target.messages[0].tool_calls?.[0].function.name).toBe('agents_wait');
  expect(chat.namespaceToolNames.targetToSource.get('agents_wait')).toEqual({ namespace: 'agents', name: 'wait' });
});

test('forced namespace choices use the declaration mapping', async () => {
  const source = payload();
  source.tool_choice = { type: 'function', namespace: 'agents', name: 'spawn' };
  expect(chatRequest(source).target.tool_choice).toEqual({ type: 'function', function: { name: 'agents_spawn_2' } });
  expect((await messagesRequest(source)).target.tool_choice).toEqual({ type: 'tool', name: 'agents_spawn_2' });
});

test('restores function and custom calls across item events and terminal snapshots', async () => {
  const prepared = flattenNamespaceTools(canonicalizeOpenAIResponsesPayload(payload()));
  const output = [
    { type: 'function_call' as const, name: 'agents_spawn_2', call_id: 'spawn', arguments: '{"name":"agents_spawn_2"}', status: 'completed' },
    { type: 'custom_tool_call' as const, name: 'agents_audit', call_id: 'audit', input: 'agents_audit' },
  ];
  const frames = (async function* (): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEvent>> {
    yield eventFrame({ type: 'response.output_item.done', output_index: 0, item: output[0] });
    yield eventFrame({ type: 'response.completed', response: { id: 'r', object: 'response', model: 'm', status: 'completed', error: null, incomplete_details: null, output } });
  })();
  const events: OpenAIResponsesStreamEvent[] = [];
  for await (const frame of restoreNamespaceEvents(frames, prepared.names.targetToSource)) if (frame.type === 'event') events.push(frame.event);
  expect(events[0]).toMatchObject({ item: { namespace: 'agents', name: 'spawn', arguments: '{"name":"agents_spawn_2"}' } });
  expect(events[1]).toMatchObject({
    response: {
      output: [
        { namespace: 'agents', name: 'spawn' }, { namespace: 'agents', name: 'audit', input: 'agents_audit' },
      ],
    },
  });
});
