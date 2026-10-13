import { expect, it } from 'vitest';

import { computeOpenAIResponsesReplayCheck, createOpenAIResponsesSidecarCarrier } from '../../../src/protocols/openai-responses/as-source/round-trip.ts';
import type { OpenAIResponsesAssistantTurn } from '../../../src/protocols/openai-responses/as-source/round-trip.ts';
import { buildTargetRequest as buildMessagesRequest } from '../../../src/protocols/openai-responses/via-anthropic-messages/request.ts';
import { buildTargetRequest as buildChatRequest } from '../../../src/protocols/openai-responses/via-openai-chat-completions/request.ts';
import { createTestSidecarCodec } from '../../round-trip/sidecar-codec.ts';
import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';

const replayedTurn: OpenAIResponsesAssistantTurn = [
  { type: 'function_call', call_id: 'native', name: 'run', namespace: 'web', arguments: '{}', status: 'completed' },
];

const request = (sidecar: string): CanonicalOpenAIResponsesPayload => ({
  model: 'test',
  tools: [
    { type: 'namespace', name: 'web', description: '', tools: [{ type: 'function', name: 'run', parameters: { type: 'object', properties: {} } }] },
  ],
  input: [
    { type: 'message', role: 'system', content: 'instructions' },
    { type: 'additional_tools', role: 'developer', tools: [{ type: 'function', name: 'web_run', parameters: { type: 'object', properties: {} } }] },
    createOpenAIResponsesSidecarCarrier('sidecar', sidecar),
    { type: 'function_call', call_id: 'native', name: 'run', namespace: 'web', arguments: '{}', status: 'completed' },
    { type: 'function_call_output', call_id: 'native', output: 'native result' },
    { type: 'function_call', call_id: 'bare', name: 'run', namespace: 'web', arguments: '{}', status: 'completed' },
  ],
});

it('keeps restored Chat history native while translating bare namespace calls', async () => {
  const codec = createTestSidecarCodec();
  const assistantTurn = {
    role: 'assistant' as const,
    content: null,
    tool_calls: [{ type: 'function' as const, id: 'native', function: { name: 'native_tool', arguments: '{}' } }],
  };
  const sidecar = await codec.encode('openaiResponses', {
    target: 'openaiChatCompletions', assistantTurn,
    replayCheck: await computeOpenAIResponsesReplayCheck(replayedTurn),
  });
  const result = await buildChatRequest(request(sidecar), codec);

  expect(result.target.messages).toEqual([
    { role: 'system', content: 'instructions' },
    assistantTurn,
    { role: 'tool', tool_call_id: 'native', content: 'native result' },
    { role: 'assistant', content: null, tool_calls: [{ type: 'function', id: 'bare', function: { name: 'web_run_2', arguments: '{}' } }] },
  ]);
});

it('keeps restored Messages history native while hoisting system and translating bare namespace calls', async () => {
  const codec = createTestSidecarCodec();
  const assistantTurn = {
    role: 'assistant' as const,
    content: [{ type: 'tool_use' as const, id: 'native', name: 'native_tool', input: {} }],
  };
  const sidecar = await codec.encode('openaiResponses', {
    target: 'anthropicMessages', assistantTurn,
    replayCheck: await computeOpenAIResponsesReplayCheck(replayedTurn),
  });
  const result = await buildMessagesRequest(request(sidecar), codec, {
    loadRemoteImage: async () => null, fallbackMaxOutputTokens: undefined,
  });

  expect(result.target.system).toEqual([{ type: 'text', text: 'instructions', cache_control: { type: 'ephemeral' } }]);
  expect(result.target.messages).toEqual([
    assistantTurn,
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'native', content: 'native result', is_error: undefined }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'bare', name: 'web_run_2', input: {}, cache_control: { type: 'ephemeral' } }] },
  ]);
});

it.each(['openaiChatCompletions', 'anthropicMessages'] as const)('bypasses ordinary namespace validation for authenticated %s history', async target => {
  const codec = createTestSidecarCodec();
  const native = target === 'openaiChatCompletions'
    ? { role: 'assistant' as const, content: 'native history' }
    : { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'native history' }] };
  const calls: CanonicalOpenAIResponsesPayload['input'] = [
    { type: 'function_call', namespace: 'x.y', name: 'f', call_id: 'first', arguments: '{}', status: 'completed' },
    { type: 'function_call', namespace: 'x', name: 'y.f', call_id: 'second', arguments: '{}', status: 'completed' },
  ];
  const sidecar = await codec.encode('openaiResponses', {
    target, assistantTurn: native,
    replayCheck: await computeOpenAIResponsesReplayCheck(calls),
  });
  const source: CanonicalOpenAIResponsesPayload = {
    model: 'test',
    input: [
      createOpenAIResponsesSidecarCarrier('carrier', sidecar), ...calls,
      { type: 'message', role: 'user', content: 'next' },
      { type: 'function_call', namespace: 'x', name: 'y.f', call_id: 'bare', arguments: '{}', status: 'completed' },
    ],
  };
  const result = target === 'openaiChatCompletions'
    ? await buildChatRequest(source, codec)
    : await buildMessagesRequest(source, codec, { loadRemoteImage: async () => null, fallbackMaxOutputTokens: undefined });

  expect(result.target.messages[0]).toEqual(native);
  expect([...result.namespaceToolNames.sourceToTarget]).toEqual([['x.y.f', 'x_y_f']]);
  expect([...result.namespaceToolNames.targetToSource]).toEqual([['x_y_f', { namespace: 'x', name: 'y.f', type: 'function_call' }]]);
  expect(source.input[1]).toEqual(calls[0]);
  expect(source.input[2]).toEqual(calls[1]);
});

it.each(['openaiChatCompletions', 'anthropicMessages'] as const)('allocates bare namespace collisions in source order after asynchronous %s replay checks', async target => {
  const codec = createTestSidecarCodec();
  const sidecar = await codec.encode('openaiResponses', {
    target: 'geminiGenerateContent', assistantTurn: [],
    replayCheck: await computeOpenAIResponsesReplayCheck([]),
  });
  const source: CanonicalOpenAIResponsesPayload = {
    model: 'test',
    input: [
      createOpenAIResponsesSidecarCarrier('carrier', sidecar),
      { type: 'function_call', namespace: 'a.b', name: 'run', call_id: 'first', arguments: '{}' },
      { type: 'message', role: 'user', content: 'next' },
      { type: 'function_call', namespace: 'a_b', name: 'run', call_id: 'second', arguments: '{}' },
    ],
  };
  const result = target === 'openaiChatCompletions'
    ? await buildChatRequest(source, codec)
    : await buildMessagesRequest(source, codec, { loadRemoteImage: async () => null, fallbackMaxOutputTokens: undefined });

  expect([...result.namespaceToolNames.sourceToTarget]).toEqual([['a.b.run', 'a_b_run'], ['a_b.run', 'a_b_run_2']]);
  expect(result.target.messages).toHaveLength(3);
});
