import { expect, test } from 'vitest';

import { toOpenAIResponsesInputAssistantTurn } from '../../src/protocols/openai-responses/as-target/assistant-turn.ts';
import { iterate } from '../ir/helpers.ts';
import { createTestSidecarCodec } from '../round-trip/sidecar-codec.ts';
import { collectAnthropicMessagesProtocolEventsToResult, type AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import { collectGeminiGenerateContentProtocolEventsToResult, type GeminiGenerateContentRequest } from '@floway-dev/protocols/gemini-generate-content';
import type { OpenAIChatCompletionsAssistantDeltaEx, OpenAIChatCompletionsPayload, OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import { collectOpenAIResponsesProtocolEventsToResult, type OpenAIResponsesRequestPayloadEx } from '@floway-dev/protocols/openai-responses';
import { routeAnthropicMessagesViaOpenAIChatCompletions, routeGeminiGenerateContentViaOpenAIChatCompletions, routeOpenAIResponsesViaOpenAIChatCompletions } from '@floway-dev/translate';

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

/**
 * What this wire states for three alternating legacy/modern calls.
 *
 * A result answers the shape its assistant turn stated: a call the turn named by
 * id gets a `tool` message, and a legacy `function_call` — which states no id —
 * gets the `function` message this wire pairs with it by name. That pairing is
 * read off the restored turn, not off the source protocol, so every source
 * reaches it the same way.
 */
const assertNativeHistory = (
  target: OpenAIChatCompletionsPayload,
  name: string,
  contents: string[],
): void => {
  const results = target.messages.filter(message => message.role === 'tool' || message.role === 'function');
  expect(results.map(message => message.content)).toEqual(contents);
  expect(results[0]).toEqual({ role: 'function', name, content: contents[0] });
  expect(results[1]).toEqual({ role: 'tool', tool_call_id: 'native-modern', content: contents[1] });
  expect(results[2]).toEqual({ role: 'function', name, content: contents[2] });
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
  const context = { sidecarCodec: createTestSidecarCodec() };
  const payload: AnthropicMessagesPayload = {
    model: 'public-model', max_tokens: 64, stream: true,
    messages: [{ role: 'user', content: 'Call lookup' }],
    tools: [{ name: 'lookup', input_schema: { type: 'object', properties: { x: { type: 'integer' } } } }],
  };
  for (const [index, mode] of (['legacy', 'modern', 'legacy'] as const).entries()) {
    const trip = await routeAnthropicMessagesViaOpenAIChatCompletions(payload, context);
    const result = await collectAnthropicMessagesProtocolEventsToResult(trip.events(iterate(nativeFrames(mode, 'lookup'))));
    const call = result.content.find(block => block.type === 'tool_use');
    if (call === undefined) throw new Error('Expected a public Messages tool invocation');
    payload.messages.push({ role: 'assistant', content: result.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: `result-${index}` }] });
  }
  const replay = await routeAnthropicMessagesViaOpenAIChatCompletions(payload, context);
  assertNativeHistory(replay.target, 'lookup', ['result-0', 'result-1', 'result-2']);
});

test('Responses binds public namespaced call IDs to the native legacy function name', async () => {
  const context = { sidecarCodec: createTestSidecarCodec() };
  const payload: OpenAIResponsesRequestPayloadEx = {
    model: 'public-model', stream: true, input: [{ type: 'message', role: 'user', content: 'Call lookup' }],
    tools: [{ type: 'namespace', name: 'public', description: 'Public lookup tools', tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object', properties: { x: { type: 'integer' } } } }] }],
  };
  let nativeName = '';
  for (const [index, mode] of (['legacy', 'modern', 'legacy'] as const).entries()) {
    const trip = await routeOpenAIResponsesViaOpenAIChatCompletions(payload, context);
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
  const replay = await routeOpenAIResponsesViaOpenAIChatCompletions(payload, context);
  assertNativeHistory(replay.target, nativeName, ['result-0', 'result-1', 'result-2']);
});

test('Gemini matches ID-less legacy responses by public name and explicit modern responses by ID', async () => {
  const context = { sidecarCodec: createTestSidecarCodec() };
  const payload: GeminiGenerateContentRequest = {
    model: 'model',
    contents: [{ role: 'user', parts: [{ text: 'Call lookup' }] }],
    tools: [{ functionDeclarations: [{ name: 'lookup', parameters: { type: 'OBJECT', properties: { x: { type: 'INTEGER' } } } }] }],
  };
  for (const [index, mode] of (['legacy', 'modern', 'legacy'] as const).entries()) {
    const trip = await routeGeminiGenerateContentViaOpenAIChatCompletions(payload, context);
    const result = await collectGeminiGenerateContentProtocolEventsToResult(trip.events(iterate(nativeFrames(mode, 'lookup'))));
    const content = result.candidates?.[0]?.content;
    const call = content?.parts?.find(part => part.functionCall !== undefined)?.functionCall;
    if (content === undefined || call === undefined || payload.contents === undefined) throw new Error('Expected a public Gemini invocation');
    expect(call.id).toBe(mode === 'modern' ? 'native-modern' : undefined);
    payload.contents.push(content, { role: 'user', parts: [{ functionResponse: { name: call.name, ...(call.id === undefined ? {} : { id: call.id }), response: { result: index } } }] });
  }
  const replay = await routeGeminiGenerateContentViaOpenAIChatCompletions(payload, context);
  assertNativeHistory(replay.target, 'lookup', ['{"result":0}', '{"result":1}', '{"result":2}']);
});

test('Gemini keeps modern IDs separate when a vendor stream includes both call formats', async () => {
  const context = { sidecarCodec: createTestSidecarCodec() };
  const source: GeminiGenerateContentRequest = { model: 'model', contents: [{ role: 'user', parts: [{ text: 'Call lookup' }] }] };
  const trip = await routeGeminiGenerateContentViaOpenAIChatCompletions(source, context);
  const result = await collectGeminiGenerateContentProtocolEventsToResult(trip.events(iterate(nativeFrames('mixed', 'lookup'))));
  const content = result.candidates?.[0]?.content;
  if (content === undefined) throw new Error('Expected a public Gemini assistant content');
  const calls = content.parts?.flatMap(part => part.functionCall === undefined ? [] : [part.functionCall]);
  expect(calls).toHaveLength(2);
  const replay = await routeGeminiGenerateContentViaOpenAIChatCompletions({
    model: 'model',
    contents: [
      ...source.contents ?? [], content,
      {
        role: 'user', parts: [
          { functionResponse: { name: 'lookup', id: 'native-modern', response: { modern: true } } },
          { functionResponse: { name: 'lookup', response: { legacy: true } } },
        ],
      },
    ],
  }, context);
  const native = replay.target.messages.find(message => message.role === 'assistant');
  expect(native?.function_call).toEqual({ name: 'lookup', arguments: '{"x":1}' });
  expect(native?.tool_calls).toEqual([{ id: 'native-modern', type: 'function', function: { name: 'lookup', arguments: '{"x":1}' } }]);
  // The id-less legacy response answers the call still awaiting a result. That
  // call is stated as a legacy `function_call`, which carries no id, so the
  // answer is written as the matching `function` message and named by the call.
  const results = replay.target.messages.slice(-2);
  expect(results.map(message => message.content)).toEqual(['{"modern":true}', '{"legacy":true}']);
  expect(results[0]).toMatchObject({ role: 'tool', tool_call_id: 'native-modern' });
  expect(results[1]).toMatchObject({ role: 'function', name: 'lookup' });
});

test('restored legacy results retain the ordinary Responses input_file rejection', async () => {
  const context = { sidecarCodec: createTestSidecarCodec() };
  const trip = await routeOpenAIResponsesViaOpenAIChatCompletions({ model: 'public-model', stream: true, input: 'Call lookup' }, context);
  const result = await collectOpenAIResponsesProtocolEventsToResult(trip.events(iterate(nativeFrames('legacy', 'lookup'))));
  const call = result.output.find(item => item.type === 'function_call');
  if (call === undefined) throw new Error('Expected a public Responses invocation');
  const output = { type: 'function_call_output' as const, call_id: call.call_id, output: [{ type: 'input_file' as const, file_id: 'unsupported-file' }] };
  const input = toOpenAIResponsesInputAssistantTurn(result.output);
  for (const history of [input, input.filter(item => item.type !== 'reasoning')]) {
    await expect(routeOpenAIResponsesViaOpenAIChatCompletions({ model: 'public-model', stream: true, input: [...history, output] }, context)).rejects.toThrow('Cannot translate file tool output to OpenAI Chat Completions.');
  }
});

test('a legacy call answered after another assistant turn is refused', async () => {
  // A legacy call states no id, so nothing names it across an assistant turn
  // that follows it: the answer could pair with either turn's calls.
  const context = { sidecarCodec: createTestSidecarCodec() };
  const payload: AnthropicMessagesPayload = {
    model: 'public-model', max_tokens: 64, stream: true,
    messages: [{ role: 'user', content: 'Call lookup' }],
    tools: [{ name: 'lookup', input_schema: { type: 'object', properties: { x: { type: 'integer' } } } }],
  };
  const trip = await routeAnthropicMessagesViaOpenAIChatCompletions(payload, context);
  const result = await collectAnthropicMessagesProtocolEventsToResult(trip.events(iterate(nativeFrames('legacy', 'lookup'))));
  const call = result.content.find(block => block.type === 'tool_use');
  if (call === undefined) throw new Error('Expected a public Messages tool invocation');
  payload.messages.push(
    { role: 'assistant', content: result.content },
    { role: 'user', content: 'still thinking' },
    { role: 'assistant', content: 'meanwhile' },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: 'late' }] },
  );
  await expect(routeAnthropicMessagesViaOpenAIChatCompletions(payload, context)).rejects.toThrow('does not answer it');
});

test('a legacy call and its answer share one client turn without being refused', async () => {
  // The result may sit anywhere inside the turn that follows the call: it is
  // the turn, not the item's position, that pairs them.
  const context = { sidecarCodec: createTestSidecarCodec() };
  for (const order of ['before', 'after'] as const) {
    const payload: AnthropicMessagesPayload = {
      model: 'public-model', max_tokens: 64, stream: true,
      messages: [{ role: 'user', content: 'Call lookup' }],
      tools: [{ name: 'lookup', input_schema: { type: 'object', properties: { x: { type: 'integer' } } } }],
    };
    const trip = await routeAnthropicMessagesViaOpenAIChatCompletions(payload, context);
    const result = await collectAnthropicMessagesProtocolEventsToResult(trip.events(iterate(nativeFrames('legacy', 'lookup'))));
    const call = result.content.find(block => block.type === 'tool_use');
    if (call === undefined) throw new Error('Expected a public Messages tool invocation');
    const answer: { role: 'user'; content: string } | { role: 'user'; content: [{ type: 'tool_result'; tool_use_id: string; content: string }] } = order === 'before'
      ? { role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: 'the-answer' }] }
      : { role: 'user', content: 'chatter' };
    const rest = order === 'before' ? { role: 'user' as const, content: 'chatter' } : { role: 'user' as const, content: [{ type: 'tool_result' as const, tool_use_id: call.id, content: 'the-answer' }] };
    payload.messages.push({ role: 'assistant', content: result.content }, answer, rest);
    const replay = await routeAnthropicMessagesViaOpenAIChatCompletions(payload, context);
    expect(replay.target.messages.filter(message => message.role === 'function')).toEqual([{ role: 'function', name: 'lookup', content: 'the-answer' }]);
  }
});
