import { expect, it } from 'vitest';

import { readOpenAIResponsesRequest } from '../../../src/protocols/openai-responses/as-source/input-to.ts';
import { computeOpenAIResponsesTurnDigest, createOpenAIResponsesSidecarItem } from '../../../src/protocols/openai-responses/as-source/round-trip.ts';
import type { OpenAIResponsesSourceAssistantTurn } from '../../../src/protocols/openai-responses/as-source/round-trip.ts';
import type { SidecarCodec } from '../../../src/round-trip/codec.ts';
import { encodeRoundTripSidecar } from '../../../src/round-trip/sidecar.ts';
import { buildTargetPayloadFor, pairs } from '../../composition/helpers.ts';
import { createTestSidecarCodec } from '../../round-trip/sidecar-codec.ts';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesRequestPayloadEx } from '@floway-dev/protocols/openai-responses';

const buildChatRequest = async (payload: OpenAIResponsesRequestPayloadEx, codec: SidecarCodec) => ({
  target: await buildTargetPayloadFor(pairs.responsesToChat[0], pairs.responsesToChat[1], { ...payload, stream: true }, { sidecarCodec: codec }),
});
const buildMessagesRequest = async (payload: OpenAIResponsesRequestPayloadEx, codec: SidecarCodec, options: { fallbackMaxOutputTokens?: number } = {}) => ({
  target: await buildTargetPayloadFor(pairs.responsesToMessages[0], pairs.responsesToMessages[1], { ...payload, stream: true }, { sidecarCodec: codec, ...options }),
});

const replayedTurn: OpenAIResponsesSourceAssistantTurn = [
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
    { type: 'function_call', call_id: 'native', name: 'run', namespace: 'web', arguments: '{}', status: 'completed' },
    createOpenAIResponsesSidecarItem('sidecar', sidecar),
    { type: 'function_call_output', call_id: 'native', output: 'native result' },
    { type: 'function_call', call_id: 'bare', name: 'run', namespace: 'web', arguments: '{}', status: 'completed' },
  ],
});

it('keeps restored Chat history native while translating bare namespace calls', async () => {
  const codec = createTestSidecarCodec();
  const targetTurn = {
    role: 'assistant' as const,
    content: null,
    tool_calls: [{ type: 'function' as const, id: 'native', function: { name: 'native_tool', arguments: '{}' } }],
  };
  const sidecar = await encodeRoundTripSidecar(codec, {
    v: 1,
    source: 'openaiResponses',
    target: 'openaiChatCompletions', targetTurn,
    sourceTurnDigest: await computeOpenAIResponsesTurnDigest(replayedTurn),
  });
  const result = await buildChatRequest(request(sidecar), codec);

  expect(result.target.messages).toEqual([
    { role: 'system', content: 'instructions' },
    targetTurn,
    { role: 'tool', tool_call_id: 'native', content: 'native result' },
    { role: 'assistant', content: null, tool_calls: [{ type: 'function', id: 'bare', function: { name: 'web_run_2', arguments: '{}' } }] },
  ]);
});

it('keeps restored Messages history native while hoisting system and translating bare namespace calls', async () => {
  const codec = createTestSidecarCodec();
  const targetTurn = {
    role: 'assistant' as const,
    content: [{ type: 'tool_use' as const, id: 'native', name: 'native_tool', input: {} }],
  };
  const sidecar = await encodeRoundTripSidecar(codec, {
    v: 1,
    source: 'openaiResponses',
    target: 'anthropicMessages', targetTurn,
    sourceTurnDigest: await computeOpenAIResponsesTurnDigest(replayedTurn),
  });
  const result = await buildMessagesRequest(request(sidecar), codec, {
    fallbackMaxOutputTokens: undefined,
  });

  expect(result.target.system).toEqual([{ type: 'text', text: 'instructions', cache_control: { type: 'ephemeral' } }]);
  expect(result.target.messages).toEqual([
    targetTurn,
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'native', content: 'native result' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'bare', name: 'web_run_2', input: {}, cache_control: { type: 'ephemeral' } }] },
  ]);
});

it.each(['openaiChatCompletions', 'anthropicMessages'] as const)('bypasses ordinary namespace validation for recognized %s history', async target => {
  const codec = createTestSidecarCodec();
  const native = target === 'openaiChatCompletions'
    ? { role: 'assistant' as const, content: 'native history' }
    : { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'native history' }] };
  const calls: CanonicalOpenAIResponsesPayload['input'] = [
    { type: 'function_call', namespace: 'x.y', name: 'f', call_id: 'first', arguments: '{}', status: 'completed' },
    { type: 'function_call', namespace: 'x', name: 'y.f', call_id: 'second', arguments: '{}', status: 'completed' },
  ];
  const sidecar = await encodeRoundTripSidecar(codec, {
    v: 1,
    source: 'openaiResponses',
    target, targetTurn: native,
    sourceTurnDigest: await computeOpenAIResponsesTurnDigest(calls),
  });
  const source: CanonicalOpenAIResponsesPayload = {
    model: 'test',
    stream: true,
    input: [
      ...calls, createOpenAIResponsesSidecarItem('carrier', sidecar),
      { type: 'message', role: 'user', content: 'next' },
      { type: 'function_call', namespace: 'x', name: 'y.f', call_id: 'bare', arguments: '{}', status: 'completed' },
    ],
  };
  const ctx = { sidecarCodec: codec, fallbackMaxOutputTokens: undefined };
  const reading = readOpenAIResponsesRequest(source);
  const irCall = (r: typeof reading, callId: string): { namespace?: string; name: string } | undefined => r.turns
    .flatMap(turn => turn.toIRInputTurns())
    .flatMap(turn => turn.items as readonly { type: string; call_id?: string; name: string; namespace?: string }[])
    .find(item => (item.type === 'function_call' || item.type === 'custom_tool_call') && item.call_id === callId);
  const target_ = target === 'openaiChatCompletions'
    ? await buildTargetPayloadFor(pairs.responsesToChat[0], pairs.responsesToChat[1], source, ctx, reading)
    : await buildTargetPayloadFor(pairs.responsesToMessages[0], pairs.responsesToMessages[1], source, ctx, reading);
  // The reading keeps a grouped call's logical identity; flattening it into the
  // single name this target's wire uses is the target's own step.
  expect(irCall(reading, 'bare')).toMatchObject({ namespace: 'x', name: 'y.f' });
  expect(target_.messages[0]).toEqual(native);
  expect(source.input[0]).toEqual(calls[0]);
  expect(source.input[1]).toEqual(calls[1]);
});

it.each(['openaiChatCompletions', 'anthropicMessages'] as const)('allocates bare namespace collisions in source order after asynchronous %s replay checks', async target => {
  const codec = createTestSidecarCodec();
  const sidecar = await encodeRoundTripSidecar(codec, {
    v: 1,
    source: 'openaiResponses',
    target: 'geminiGenerateContent', targetTurn: [],
    sourceTurnDigest: await computeOpenAIResponsesTurnDigest([]),
  });
  const source: CanonicalOpenAIResponsesPayload = {
    model: 'test',
    stream: true,
    input: [
      { type: 'function_call', namespace: 'a.b', name: 'run', call_id: 'first', arguments: '{}' },
      createOpenAIResponsesSidecarItem('carrier', sidecar),
      { type: 'message', role: 'user', content: 'next' },
      { type: 'function_call', namespace: 'a_b', name: 'run', call_id: 'second', arguments: '{}' },
    ],
  };
  const ctx = { sidecarCodec: codec, fallbackMaxOutputTokens: undefined };
  const reading = readOpenAIResponsesRequest(source);
  const target_ = target === 'openaiChatCompletions'
    ? await buildTargetPayloadFor(pairs.responsesToChat[0], pairs.responsesToChat[1], source, ctx, reading)
    : await buildTargetPayloadFor(pairs.responsesToMessages[0], pairs.responsesToMessages[1], source, ctx, reading);
  // Two groups spelling the same flat name must not collide on the wire, and
  // which one takes the suffix follows the order the conversation states them.
  const callNames = target === 'openaiChatCompletions'
    ? (target_.messages as Array<{ tool_calls?: Array<{ function: { name: string } }> }>)
        .flatMap(message => message.tool_calls?.map(call => call.function.name) ?? [])
    : (target_.messages as Array<{ content: unknown }>).flatMap(message => Array.isArray(message.content)
        ? message.content.flatMap(block => (block as { type: string; name?: string }).type === 'tool_use' ? [(block as { name: string }).name] : [])
        : []);
  expect(callNames).toEqual(['a_b_run', 'a_b_run_2']);
  expect(target_.messages).toHaveLength(3);
});

it.each(['additional_tools', 'tool_search_output'] as const)('restores assistant turns independently across a user-side %s boundary', async type => {
  for (const target of ['openaiChatCompletions', 'anthropicMessages'] as const) {
    const codec = createTestSidecarCodec();
    const nativeTurns = ['first', 'second'].map(text => target === 'openaiChatCompletions'
      ? { role: 'assistant' as const, content: text, reasoning_content: `opaque ${text}` }
      : { role: 'assistant' as const, content: [{ type: 'thinking' as const, thinking: text, signature: `opaque ${text}` }] });
    const turns: CanonicalOpenAIResponsesPayload['input'][] = ['first', 'second'].map(text => [
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
    ]);
    const carriers = await Promise.all(turns.map(async (turn, index) => createOpenAIResponsesSidecarItem(`carrier_${index}`, await encodeRoundTripSidecar(codec, {
      v: 1,
      source: 'openaiResponses',
      target, targetTurn: nativeTurns[index], sourceTurnDigest: await computeOpenAIResponsesTurnDigest(turn),
    }))));
    const inventory = type === 'additional_tools'
      ? { type, role: 'developer' as const, tools: [{ type: 'function' as const, name: 'lookup' }] }
      : { type, call_id: 'load', execution: 'client' as const, tools: [{ type: 'function' as const, name: 'lookup' }] };
    const source: CanonicalOpenAIResponsesPayload = {
      model: 'test', stream: true, input: [...turns[0], carriers[0], inventory, ...turns[1], carriers[1]],
    };
    const original = structuredClone(source);
    const result = target === 'openaiChatCompletions'
      ? { target: await buildTargetPayloadFor(pairs.responsesToChat[0], pairs.responsesToChat[1], source, { sidecarCodec: codec }) }
      : await buildMessagesRequest(source, codec, { fallbackMaxOutputTokens: undefined });

    expect(result.target.messages).toEqual(nativeTurns);
    expect(result.target.tools).toHaveLength(1);
    expect(source).toEqual(original);
  }
});
