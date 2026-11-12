import { expect, test, vi } from 'vitest';

import { openaiResponsesSourceProtocol } from '../../src/protocols/openai-responses/as-source.ts';
import { toOpenAIResponsesInputAssistantTurn } from '../../src/protocols/openai-responses/as-target/assistant-turn.ts';
import { iterate } from '../shared/iterables.ts';
import { createTestSidecarCodec } from '../round-trip/sidecar-codec.ts';
import { expectTrip } from '../trip.ts';
import { createAnthropicMessagesUsage, toAnthropicMessagesUsageDelta, type AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import { collectGeminiGenerateContentProtocolEventsToResult } from '@floway-dev/protocols/gemini-generate-content';
import type { GeminiGenerateContentRequest } from '@floway-dev/protocols/gemini-generate-content';
import { collectOpenAIChatCompletionsProtocolEventsToResult, type OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import { collectOpenAIResponsesProtocolEventsToResult } from '@floway-dev/protocols/openai-responses';
import type { OpenAIResponsesRequestPayloadEx, OpenAIResponsesStreamEventEx, OpenAIResponsesTool } from '@floway-dev/protocols/openai-responses';
import { routeGeminiGenerateContentViaAnthropicMessages, routeGeminiGenerateContentViaOpenAIChatCompletions, routeGeminiGenerateContentViaOpenAIResponses, routeOpenAIChatCompletionsViaAnthropicMessages, routeOpenAIChatCompletionsViaOpenAIResponses, routeOpenAIResponsesViaAnthropicMessages, routeOpenAIResponsesViaOpenAIChatCompletions } from '@floway-dev/translate';

const chatFrames = (name: string, arguments_: string, legacy = false): ProtocolFrame<OpenAIChatCompletionsStreamEvent>[] => [
  eventFrame({
    id: 'chat', object: 'chat.completion.chunk', created: 1, model: 'm',
    choices: [{
      index: 0, delta: {
        role: 'assistant', reasoning_content: 'native reasoning',
        ...(legacy ? { function_call: { name, arguments: arguments_ } } : { tool_calls: [{ index: 0, type: 'function', id: 'native', function: { name, arguments: arguments_ } }] }),
      }, finish_reason: legacy ? 'function_call' : 'tool_calls',
    }],
  }),
  doneFrame(),
];

const messagesFrames = (name: string, arguments_: string): ProtocolFrame<AnthropicMessagesStreamEventEx>[] => [
  eventFrame({ type: 'message_start', message: { id: 'message', type: 'message', role: 'assistant', model: 'm', content: [], stop_reason: null, stop_sequence: null, stop_details: null, container: null, usage: createAnthropicMessagesUsage(1, 0) } }),
  eventFrame({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 'native reasoning', signature: 'native signature' } }),
  eventFrame({ type: 'content_block_stop', index: 0 }),
  eventFrame({ type: 'content_block_start', index: 1, content_block: { type: 'redacted_thinking', data: 'native encrypted blob' } }),
  eventFrame({ type: 'content_block_stop', index: 1 }),
  eventFrame({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'native', name, input: {} } }),
  eventFrame({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: arguments_ } }),
  eventFrame({ type: 'content_block_stop', index: 2 }),
  eventFrame({ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null, container: null, stop_details: null }, usage: toAnthropicMessagesUsageDelta(createAnthropicMessagesUsage(1, 1)) }),
  eventFrame({ type: 'message_stop' }),
];

const responsesFrames = (): ProtocolFrame<OpenAIResponsesStreamEventEx>[] => {
  const item = { type: 'function_call' as const, id: 'item', call_id: 'native', name: 'same', arguments: '{"n":1}', status: 'completed' as const };
  return [
    eventFrame({ type: 'response.created', sequence_number: 0, response: { id: 'r', object: 'response', model: 'm', status: 'in_progress', incomplete_details: null, error: null, output: [] } }),
    eventFrame({ type: 'response.output_item.added', sequence_number: 1, output_index: 0, item: { ...item, arguments: '', status: 'in_progress' } }),
    eventFrame({ type: 'response.function_call_arguments.delta', sequence_number: 2, item_id: 'item', output_index: 0, delta: item.arguments }),
    eventFrame({ type: 'response.function_call_arguments.done', sequence_number: 3, item_id: 'item', output_index: 0, arguments: item.arguments }),
    eventFrame({ type: 'response.output_item.done', sequence_number: 4, output_index: 0, item }),
    eventFrame({ type: 'response.completed', sequence_number: 5, response: { id: 'r', object: 'response', model: 'm', status: 'completed', incomplete_details: null, error: null, output: [item] } }),
  ];
};

const group = (kind: 'function' | 'custom'): OpenAIResponsesTool => ({
  type: 'namespace', name: 'web', description: 'Web tools',
  tools: [kind === 'function' ? { type: 'function', name: 'run', parameters: { type: 'object', properties: {} } } : { type: 'custom', name: 'run', format: { type: 'text' } }],
});

test.each([['chat', 'function'], ['chat', 'custom'], ['messages', 'function'], ['messages', 'custom']] as const)('native %s %s calls share logical aliases with declarations, selectors and ordinary history', async (target, kind) => {
  const options = { sidecarCodec: createTestSidecarCodec() };
  const source: OpenAIResponsesRequestPayloadEx = { model: 'm', stream: true, input: 'start', tools: [group(kind)] };
  const args = kind === 'function' ? '{}' : '{"input":"raw"}';
  const result = target === 'chat'
    ? await collectOpenAIResponsesProtocolEventsToResult(expectTrip(await routeOpenAIResponsesViaOpenAIChatCompletions(source, options)).events(iterate(chatFrames('web_run', args))))
    : await collectOpenAIResponsesProtocolEventsToResult(expectTrip(await routeOpenAIResponsesViaAnthropicMessages(source, options)).events(iterate(messagesFrames('web_run', args))));
  const call = result.output.find(item => item.type === 'function_call' || item.type === 'custom_tool_call');
  if (call === undefined) throw new Error('Expected the public callable and its replay sidecar.');
  expect(call).toMatchObject({ type: kind === 'function' ? 'function_call' : 'custom_tool_call', name: 'run', namespace: 'web' });
  const request: OpenAIResponsesRequestPayloadEx = {
    model: 'm', stream: true,
    tools: [group(kind), { type: 'function', name: 'web_run', parameters: { type: 'object', properties: {} } }],
    tool_choice: { type: 'allowed_tools', mode: 'required', tools: [{ type: kind, name: 'run', namespace: 'web' }] },
    input: [
      ...toOpenAIResponsesInputAssistantTurn(result.output),
      kind === 'function' ? { type: 'function_call_output', call_id: call.call_id, output: 'ok' } : { type: 'custom_tool_call_output', call_id: call.call_id, output: 'ok' },
      kind === 'function' ? { type: 'function_call', call_id: 'ordinary', name: 'run', namespace: 'web', arguments: '{}' } : { type: 'custom_tool_call', call_id: 'ordinary', name: 'run', namespace: 'web', input: 'again' },
    ],
  };
  const original = structuredClone(request);
  const read = openaiResponsesSourceProtocol.read;
  const toIR = vi.fn(() => { throw new Error('Native replay must not build IR.'); });
  const spy = vi.spyOn(openaiResponsesSourceProtocol, 'read').mockImplementation(payload => {
    const reading = read(payload);
    return { ...reading, turns: reading.turns.map(turn => turn.kind === 'assistant' && turn.assistantTurn.some(item => item.type === 'reasoning' && typeof item.encrypted_content === 'string') ? { ...turn, toIRInputTurns: toIR } : turn) };
  });
  try {
    if (target === 'chat') {
      const trip = expectTrip(await routeOpenAIResponsesViaOpenAIChatCompletions(request, options));
      expect(trip.target.tools?.map(tool => tool.type === 'function' ? tool.function.name : tool.custom.name)).toEqual(['web_run_2', 'web_run']);
      expect(trip.target.tool_choice).toEqual({ type: 'allowed_tools', allowed_tools: { mode: 'required', tools: [{ type: 'function', function: { name: 'web_run_2' } }] } });
      const calls = trip.target.messages.flatMap(message => message.role === 'assistant' ? message.tool_calls ?? [] : []);
      expect(calls.map(item => item.type === 'function' ? item.function.name : item.custom.name)).toEqual(['web_run_2', 'web_run_2']);
      expect(trip.target.messages[0]).toMatchObject({ reasoning_content: 'native reasoning' });
      const returned = await collectOpenAIResponsesProtocolEventsToResult(trip.events(iterate(chatFrames('web_run_2', args))));
      expect(returned.output.find(item => item.type === 'function_call' || item.type === 'custom_tool_call')).toMatchObject({ type: kind === 'function' ? 'function_call' : 'custom_tool_call', name: 'run', namespace: 'web' });
    } else {
      const trip = expectTrip(await routeOpenAIResponsesViaAnthropicMessages(request, options));
      expect(trip.target.tools?.map(tool => 'name' in tool ? tool.name : undefined)).toEqual(['web_run_2', 'web_run']);
      expect(trip.target.tool_choice).toEqual({ type: 'tool', name: 'web_run_2' });
      const calls = trip.target.messages.flatMap(message => message.role === 'assistant' && Array.isArray(message.content) ? message.content.flatMap(block => block.type === 'tool_use' ? [block] : []) : []);
      expect(calls.map(item => item.name)).toEqual(['web_run_2', 'web_run_2']);
      expect(trip.target.messages[0].content).toContainEqual({ type: 'thinking', thinking: 'native reasoning', signature: 'native signature' });
      expect(trip.target.messages[0].content).toContainEqual({ type: 'redacted_thinking', data: 'native encrypted blob' });
      const returned = await collectOpenAIResponsesProtocolEventsToResult(trip.events(iterate(messagesFrames('web_run_2', args))));
      expect(returned.output.find(item => item.type === 'function_call' || item.type === 'custom_tool_call')).toMatchObject({ type: kind === 'function' ? 'function_call' : 'custom_tool_call', name: 'run', namespace: 'web' });
    }
    expect(toIR).not.toHaveBeenCalled();
    expect(request).toEqual(original);
  } finally {
    spy.mockRestore();
  }
});

test('native legacy Chat aliases are rebound without adding a wire call ID', async () => {
  const options = { sidecarCodec: createTestSidecarCodec() };
  const first = expectTrip(await routeOpenAIResponsesViaOpenAIChatCompletions({ model: 'm', stream: true, input: 'start', tools: [group('function')] }, options));
  const result = await collectOpenAIResponsesProtocolEventsToResult(first.events(iterate(chatFrames('web_run', '{}', true))));
  const call = result.output.find(item => item.type === 'function_call');
  if (call === undefined) throw new Error('Expected the public legacy call.');
  const replay = expectTrip(await routeOpenAIResponsesViaOpenAIChatCompletions({
    model: 'm', stream: true, tools: [group('function'), { type: 'function', name: 'web_run', parameters: { type: 'object', properties: {} } }],
    input: [...toOpenAIResponsesInputAssistantTurn(result.output), { type: 'function_call_output', call_id: call.call_id, output: 'ok' }],
  }, options));
  expect(replay.target.messages[0]).toMatchObject({ role: 'assistant', function_call: { name: 'web_run_2', arguments: '{}' }, reasoning_content: 'native reasoning' });
  expect(replay.target.messages[0]).not.toHaveProperty('tool_calls');
  expect(replay.target.messages[1]).toEqual({ role: 'function', name: 'web_run_2', content: 'ok' });
});

test.each(['chat', 'messages', 'responses'] as const)('Gemini id-less results answer the complete native and ordinary %s history in FIFO order', async target => {
  const options = { sidecarCodec: createTestSidecarCodec() };
  const source: GeminiGenerateContentRequest = { model: 'm', contents: [{ role: 'user', parts: [{ text: 'start' }] }] };
  const first = target === 'chat'
    ? await collectGeminiGenerateContentProtocolEventsToResult(expectTrip(await routeGeminiGenerateContentViaOpenAIChatCompletions(source, options)).events(iterate(chatFrames('same', '{"n":1}'))))
    : target === 'messages'
      ? await collectGeminiGenerateContentProtocolEventsToResult(expectTrip(await routeGeminiGenerateContentViaAnthropicMessages(source, options)).events(iterate(messagesFrames('same', '{"n":1}'))))
      : await collectGeminiGenerateContentProtocolEventsToResult(expectTrip(await routeGeminiGenerateContentViaOpenAIResponses(source, options)).events(iterate(responsesFrames())));
  const native = first.candidates?.[0]?.content;
  if (native === undefined) throw new Error('Expected a public Gemini assistant turn.');
  const request: GeminiGenerateContentRequest = {
    model: 'm', contents: [
      ...source.contents ?? [], native,
      { role: 'user', parts: [{ text: 'also call it again' }] },
      { role: 'model', parts: [{ functionCall: { name: 'same', args: { n: 2 } } }] },
      { role: 'user', parts: [{ functionResponse: { name: 'same', response: { answer: 'FIRST' } } }, { functionResponse: { name: 'same', response: { answer: 'SECOND' } } }] },
    ],
  };
  if (target === 'chat') {
    const trip = expectTrip(await routeGeminiGenerateContentViaOpenAIChatCompletions(request, options));
    const answers = trip.target.messages.filter(message => message.role === 'tool');
    expect(answers.map(message => message.tool_call_id)).toEqual(['native', 'same_call_1']);
    expect(answers.map(message => message.content)).toEqual(['{"answer":"FIRST"}', '{"answer":"SECOND"}']);
    expect(trip.target.messages[1]).toMatchObject({ reasoning_content: 'native reasoning' });
  } else if (target === 'messages') {
    const trip = expectTrip(await routeGeminiGenerateContentViaAnthropicMessages(request, options));
    const answers = trip.target.messages.flatMap(message => message.role === 'user' && Array.isArray(message.content) ? message.content.flatMap(block => block.type === 'tool_result' ? [block] : []) : []);
    expect(answers.map(block => block.tool_use_id)).toEqual(['native', 'same_call_1']);
    expect(answers.map(block => block.content)).toEqual(['{"answer":"FIRST"}', '{"answer":"SECOND"}']);
  } else {
    const trip = expectTrip(await routeGeminiGenerateContentViaOpenAIResponses(request, options));
    const answers = trip.target.input.filter(item => item.type === 'function_call_output');
    expect(answers.map(item => item.call_id)).toEqual(['native', 'same_call_1']);
    expect(answers.map(item => item.output)).toEqual(['{"answer":"FIRST"}', '{"answer":"SECOND"}']);
  }
});

test('Gemini target allocation reserves explicit IDs against every missing-ID call', async () => {
  const options = { sidecarCodec: createTestSidecarCodec() };
  const source: GeminiGenerateContentRequest = {
    model: 'm', contents: [
      { role: 'model', parts: [{ functionCall: { name: 'first', args: {} } }, { functionCall: { id: 'first_call_1', name: 'second', args: {} } }, { functionCall: { id: 'gemini_call_0_0', name: 'third', args: {} } }] },
      { role: 'user', parts: [{ functionResponse: { id: 'first_call_1', name: 'second', response: { answer: 'SECOND' } } }, { functionResponse: { name: 'first', response: { answer: 'FIRST' } } }, { functionResponse: { id: 'gemini_call_0_0', name: 'third', response: { answer: 'THIRD' } } }] },
    ],
  };
  const trip = expectTrip(await routeGeminiGenerateContentViaOpenAIResponses(source, options));
  const calls = trip.target.input.filter(item => item.type === 'function_call');
  const answers = trip.target.input.filter(item => item.type === 'function_call_output');
  expect(new Set(calls.map(call => call.call_id)).size).toBe(3);
  expect(answers.map(item => item.call_id)).toEqual(['first_call_1', calls[0].call_id, 'gemini_call_0_0']);
});

test.each(['messages', 'responses'] as const)('Chat legacy IDs stay distinct from modern explicit IDs through %s translation', async target => {
  const options = { sidecarCodec: createTestSidecarCodec() };
  const source = {
    model: 'm', stream: true, messages: [
      { role: 'assistant' as const, content: null, function_call: { name: 'first', arguments: '{}' } },
      { role: 'user' as const, content: 'next' },
      { role: 'assistant' as const, content: null, tool_calls: [{ id: 'legacy__first__0', type: 'function' as const, function: { name: 'second', arguments: '{}' } }] },
      { role: 'tool' as const, tool_call_id: 'legacy__first__0', content: 'SECOND' },
      { role: 'function' as const, name: 'first', content: 'FIRST' },
    ],
  };
  if (target === 'responses') {
    const trip = expectTrip(await routeOpenAIChatCompletionsViaOpenAIResponses(source, options));
    const calls = trip.target.input.filter(item => item.type === 'function_call');
    expect(new Set(calls.map(call => call.call_id)).size).toBe(2);
    expect(trip.target.input.filter(item => item.type === 'function_call_output').map(item => item.call_id)).toEqual(['legacy__first__0', calls[0].call_id]);
  } else {
    const trip = expectTrip(await routeOpenAIChatCompletionsViaAnthropicMessages(source, options));
    const calls = trip.target.messages.flatMap(message => message.role === 'assistant' && Array.isArray(message.content) ? message.content.flatMap(block => block.type === 'tool_use' ? [block] : []) : []);
    expect(new Set(calls.map(call => call.id)).size).toBe(2);
    expect(trip.target.messages.flatMap(message => message.role === 'user' && Array.isArray(message.content) ? message.content.flatMap(block => block.type === 'tool_result' ? [block.tool_use_id] : []) : [])).toEqual(['legacy__first__0', calls[0].id]);
  }
});

test('Chat source custom identity renames native Messages calls independently from same-name functions', async () => {
  const options = { sidecarCodec: createTestSidecarCodec() };
  const first = expectTrip(await routeOpenAIChatCompletionsViaAnthropicMessages({
    model: 'm', stream: true, messages: [{ role: 'user', content: 'start' }],
    tools: [{ type: 'custom', custom: { name: 'edit' } }],
  }, options));
  const result = await collectOpenAIChatCompletionsProtocolEventsToResult(first.events(iterate(messagesFrames('edit', '{"input":"raw"}'))));
  const replay = expectTrip(await routeOpenAIChatCompletionsViaAnthropicMessages({
    model: 'm', stream: true,
    tools: [{ type: 'function', function: { name: 'edit', parameters: { type: 'object', properties: {} } } }, { type: 'custom', custom: { name: 'edit' } }],
    messages: [result.choices[0].message, { role: 'tool', tool_call_id: 'native', content: 'ok' }, { role: 'assistant', content: null, tool_calls: [{ type: 'custom', id: 'later', custom: { name: 'edit', input: 'later' } }] }],
  }, options));
  const calls = replay.target.messages.flatMap(message => message.role === 'assistant' && Array.isArray(message.content) ? message.content.flatMap(block => block.type === 'tool_use' ? [block] : []) : []);
  expect(calls.map(call => call.name)).toEqual(['edit_2', 'edit_2']);
  expect(calls.map(call => call.input)).toEqual([{ input: 'raw' }, { input: 'later' }]);
  expect(replay.target.messages[0].content).toContainEqual({ type: 'thinking', thinking: 'native reasoning', signature: 'native signature' });
});
