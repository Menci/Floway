import { expect, test } from 'vitest';

import { toOpenAIResponsesInputAssistantTurn } from '../../src/protocols/openai-responses/as-target/assistant-turn.ts';
import { iterate } from '../ir/helpers.ts';
import { createTestSidecarCodec } from '../round-trip/sidecar-codec.ts';
import { collectAnthropicMessagesProtocolEventsToResult, type AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import { collectGeminiGenerateContentProtocolEventsToResult, type GeminiGenerateContentPayload } from '@floway-dev/protocols/gemini-generate-content';
import type { OpenAIChatCompletionsAssistantDeltaEx, OpenAIChatCompletionsPayload, OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import { collectOpenAIResponsesProtocolEventsToResult, type OpenAIResponsesRequestPayloadEx } from '@floway-dev/protocols/openai-responses';
import { routeAnthropicMessages } from '@floway-dev/translate/anthropic-messages';
import { routeGeminiGenerateContent } from '@floway-dev/translate/gemini-generate-content';
import { routeOpenAIResponses } from '@floway-dev/translate/openai-responses';

const nativeFrames = (mode: 'legacy' | 'modern' | 'mixed', name: string, arguments_ = '{"x":1}'): ProtocolFrame<OpenAIChatCompletionsStreamEvent>[] => {
  const chunk = (delta: OpenAIChatCompletionsAssistantDeltaEx, finish_reason: 'function_call' | 'tool_calls' | null = null) => eventFrame({
    id: 'chat-native', object: 'chat.completion.chunk' as const, model: 'native-model', created: 1,
    choices: [{ index: 0, delta, finish_reason }],
  });
  return [
    chunk({ role: 'assistant' }),
    chunk({
      ...(mode === 'modern' ? {} : { function_call: { name, arguments: arguments_ } }),
      ...(mode === 'legacy' ? {} : { tool_calls: [{ index: 0, id: 'native-modern', type: 'function' as const, function: { name, arguments: arguments_ } }] }),
    }),
    chunk({}, mode === 'legacy' ? 'function_call' : 'tool_calls'),
    doneFrame(),
  ];
};

const assertNativeHistory = (target: OpenAIChatCompletionsPayload, name: string, contents: string[]): void => {
  expect(target.messages.filter(message => message.role === 'function' || message.role === 'tool')).toEqual([
    { role: 'function', name, content: contents[0] },
    { role: 'tool', tool_call_id: 'native-modern', content: contents[1] },
    { role: 'function', name, content: contents[2] },
  ]);
  const assistants = target.messages.filter(message => message.role === 'assistant');
  expect(assistants).toHaveLength(3);
  expect(assistants[0].function_call).toEqual({ name, arguments: '{"x":1}' });
  expect(assistants[0].tool_calls).toBeUndefined();
  expect(assistants[1].function_call).toBeUndefined();
  expect(assistants[1].tool_calls).toEqual([{ id: 'native-modern', type: 'function', function: { name, arguments: '{"x":1}' } }]);
  expect(assistants[2].function_call).toEqual({ name, arguments: '{"x":1}' });
  expect(assistants[2].tool_calls).toBeUndefined();
};

test('Messages returns matching legacy function results while modern calls remain tool messages across turns', async () => {
  const context = { model: 'native-model', sidecarCodec: createTestSidecarCodec() };
  const payload: AnthropicMessagesPayload = {
    model: 'public-model', max_tokens: 64,
    messages: [{ role: 'user', content: 'Call lookup' }],
    tools: [{ name: 'lookup', input_schema: { type: 'object', properties: { x: { type: 'integer' } } } }],
  };
  for (const [index, mode] of (['legacy', 'modern', 'legacy'] as const).entries()) {
    const trip = await routeAnthropicMessages(payload).viaOpenAIChatCompletions(context);
    const result = await collectAnthropicMessagesProtocolEventsToResult(trip.events(iterate(nativeFrames(mode, 'lookup'))));
    const call = result.content.find(block => block.type === 'tool_use');
    if (call === undefined) throw new Error('Expected a public Messages tool invocation');
    payload.messages.push({ role: 'assistant', content: result.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: `result-${index}` }] });
  }
  const replay = await routeAnthropicMessages(payload).viaOpenAIChatCompletions(context);
  assertNativeHistory(replay.target, 'lookup', ['result-0', 'result-1', 'result-2']);
});

test('Responses binds public namespaced call IDs to the native legacy function name', async () => {
  const context = { model: 'native-model', sidecarCodec: createTestSidecarCodec() };
  const payload: OpenAIResponsesRequestPayloadEx = {
    model: 'public-model', input: [{ type: 'message', role: 'user', content: 'Call lookup' }],
    tools: [{ type: 'namespace', name: 'public', description: 'Public lookup tools', tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object', properties: { x: { type: 'integer' } } } }] }],
  };
  let nativeName = '';
  for (const [index, mode] of (['legacy', 'modern', 'legacy'] as const).entries()) {
    const trip = await routeOpenAIResponses(payload).viaOpenAIChatCompletions(context);
    const declaration = trip.target.tools?.find(tool => tool.type === 'function');
    if (declaration?.type !== 'function') throw new Error('Expected a native function declaration');
    nativeName = declaration.function.name;
    expect(nativeName).not.toBe('lookup');
    const result = await collectOpenAIResponsesProtocolEventsToResult(trip.events(iterate(nativeFrames(mode, nativeName))));
    const call = result.output.find(item => item.type === 'function_call');
    if (call === undefined) throw new Error('Expected a public Responses function invocation');
    expect(call.name).toBe('lookup');
    expect(call.namespace).toBe('public');
    if (!Array.isArray(payload.input)) throw new Error('Expected item-array history');
    payload.input.push(...toOpenAIResponsesInputAssistantTurn(result.output), { type: 'function_call_output', call_id: call.call_id, output: `result-${index}` });
  }
  const replay = await routeOpenAIResponses(payload).viaOpenAIChatCompletions(context);
  assertNativeHistory(replay.target, nativeName, ['result-0', 'result-1', 'result-2']);
});

test('Gemini matches ID-less legacy responses by public name and explicit modern responses by ID', async () => {
  const context = { model: 'native-model', sidecarCodec: createTestSidecarCodec() };
  const payload: GeminiGenerateContentPayload = {
    contents: [{ role: 'user', parts: [{ text: 'Call lookup' }] }],
    tools: [{ functionDeclarations: [{ name: 'lookup', parameters: { type: 'OBJECT', properties: { x: { type: 'INTEGER' } } } }] }],
  };
  for (const [index, mode] of (['legacy', 'modern', 'legacy'] as const).entries()) {
    const trip = await routeGeminiGenerateContent(payload).viaOpenAIChatCompletions(context);
    const result = await collectGeminiGenerateContentProtocolEventsToResult(trip.events(iterate(nativeFrames(mode, 'lookup'))));
    const content = result.candidates?.[0]?.content;
    const call = content?.parts?.find(part => part.functionCall !== undefined)?.functionCall;
    if (content === undefined || call === undefined || payload.contents === undefined) throw new Error('Expected a public Gemini invocation');
    expect(call.id).toBe(mode === 'modern' ? 'native-modern' : undefined);
    payload.contents.push(content, { role: 'user', parts: [{ functionResponse: { name: call.name, ...(call.id === undefined ? {} : { id: call.id }), response: { result: index } } }] });
  }
  const replay = await routeGeminiGenerateContent(payload).viaOpenAIChatCompletions(context);
  assertNativeHistory(replay.target, 'lookup', ['{"result":0}', '{"result":1}', '{"result":2}']);
});

test('Gemini keeps modern IDs separate when a vendor stream includes both call formats', async () => {
  const context = { model: 'native-model', sidecarCodec: createTestSidecarCodec() };
  const source: GeminiGenerateContentPayload = { contents: [{ role: 'user', parts: [{ text: 'Call lookup' }] }] };
  const trip = await routeGeminiGenerateContent(source).viaOpenAIChatCompletions(context);
  const result = await collectGeminiGenerateContentProtocolEventsToResult(trip.events(iterate(nativeFrames('mixed', 'lookup'))));
  const content = result.candidates?.[0]?.content;
  if (content === undefined) throw new Error('Expected a public Gemini assistant content');
  const calls = content.parts?.flatMap(part => part.functionCall === undefined ? [] : [part.functionCall]);
  expect(calls).toHaveLength(2);
  const replay = await routeGeminiGenerateContent({
    contents: [
      ...source.contents ?? [], content,
      {
        role: 'user', parts: [
          { functionResponse: { name: 'lookup', id: 'native-modern', response: { modern: true } } },
          { functionResponse: { name: 'lookup', response: { legacy: true } } },
        ],
      },
    ],
  }).viaOpenAIChatCompletions(context);
  const native = replay.target.messages.find(message => message.role === 'assistant');
  expect(native?.function_call).toEqual({ name: 'lookup', arguments: '{"x":1}' });
  expect(native?.tool_calls).toEqual([{ id: 'native-modern', type: 'function', function: { name: 'lookup', arguments: '{"x":1}' } }]);
  expect(replay.target.messages.slice(-2)).toEqual([
    { role: 'tool', tool_call_id: 'native-modern', content: '{"modern":true}' },
    { role: 'function', name: 'lookup', content: '{"legacy":true}' },
  ]);
});

test('restored legacy results retain the ordinary Responses input_file rejection', async () => {
  const context = { model: 'native-model', sidecarCodec: createTestSidecarCodec() };
  const trip = await routeOpenAIResponses({ model: 'public-model', input: 'Call lookup' }).viaOpenAIChatCompletions(context);
  const result = await collectOpenAIResponsesProtocolEventsToResult(trip.events(iterate(nativeFrames('legacy', 'lookup'))));
  const call = result.output.find(item => item.type === 'function_call');
  if (call === undefined) throw new Error('Expected a public Responses invocation');
  const output = { type: 'function_call_output' as const, call_id: call.call_id, output: [{ type: 'input_file' as const, file_id: 'unsupported-file' }] };
  const input = toOpenAIResponsesInputAssistantTurn(result.output);
  for (const history of [input, input.filter(item => item.type !== 'reasoning')]) {
    await expect(routeOpenAIResponses({ model: 'public-model', input: [...history, output] }).viaOpenAIChatCompletions(context)).rejects.toThrow('Cannot translate input_file tool output to OpenAI Chat Completions.');
  }
});
