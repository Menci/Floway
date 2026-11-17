import { expect, test, vi } from 'vitest';

import { fixtureFrames, nativeResult } from './fixtures.ts';
import { writeAnthropicMessagesEvents, writeGeminiGenerateContentEvents, readAnthropicMessagesEvents, readOpenAIChatCompletionsEvents, readOpenAIResponsesEvents, writeOpenAIResponsesEvents } from './helpers.ts';
import { createIRBuilder } from '../../src/ir/output/builder.ts';
import { readOpenAIChatCompletionsEvents as irFromOpenAIChatCompletionsProduction } from '../../src/protocols/openai-chat-completions/as-target/events.ts';
import { buildSourceEventsFor, buildTargetPayloadFor, emptyPayload, pairs } from '../composition/helpers.ts';
import { collectIR, completeIR } from '../ir/output/helpers.ts';
import { createTestSidecarCodec } from '../round-trip/sidecar-codec.ts';
import { createRoundTripReaderCapture } from '../round-trip/test-helpers.ts';
import { collect, iterate } from '../shared/iterables.ts';
import { eventFrame } from '@floway-dev/protocols/common';

const events = (pair: readonly [any, any], payload: any, codec: any) =>
  (frames: AsyncIterable<any>) => buildSourceEventsFor(pair[0], pair[1], payload, { sidecarCodec: codec }, frames);
const messagesViaChat = (frames: AsyncIterable<any>, codec: any) => events(pairs.messagesToChat, emptyPayload.messages, codec)(frames);
const messagesViaResponses = (frames: AsyncIterable<any>, codec: any) => events(pairs.messagesToResponses, emptyPayload.messages, codec)(frames);
const generateContentViaChat = (frames: AsyncIterable<any>, codec: any) => events(pairs.geminiToChat, emptyPayload.gemini, codec)(frames);
const generateContentViaResponses = (frames: AsyncIterable<any>, codec: any) => events(pairs.geminiToResponses, emptyPayload.gemini, codec)(frames);
// The freeform tool names these cases restore come from the request's own
// declarations, so a case that expects one states it there.
const responsesViaMessages = (frames: AsyncIterable<any>, names: ReadonlySet<string>, codec: any) =>
  buildSourceEventsFor(pairs.responsesToMessages[0], pairs.responsesToMessages[1], responsesPayload(names), { sidecarCodec: codec }, frames);
const responsesViaChat = (frames: AsyncIterable<any>, names: ReadonlySet<string>, codec: any) =>
  buildSourceEventsFor(pairs.responsesToChat[0], pairs.responsesToChat[1], responsesPayload(names), { sidecarCodec: codec }, frames);
const responsesPayload = (names: ReadonlySet<string>) => ({
  ...emptyPayload.responses,
  tools: [...names].map(name => ({ type: 'custom' as const, name, description: '', format: { type: 'text' as const } })),
  tool_choice: 'auto' as const,
});
const messagesRequestViaChat = (payload: any, codec: any) =>
  buildTargetPayloadFor(pairs.messagesToChat[0], pairs.messagesToChat[1], payload, { sidecarCodec: codec });

for (const [code, category] of [['bio_policy', 'bio']] as const) {
  test(`${code} becomes a structured Messages classifier refusal without invented body text`, async () => {
    const source = [eventFrame({ type: 'response.failed', response: { id: 'resp_policy', model: 'served', output: [], status: 'failed', error: { code, message: 'Classifier declined.' } } })];
    const frames = await collect(messagesViaResponses(iterate(source as any), createTestSidecarCodec()));
    const result = await nativeResult('anthropic-messages', frames);
    expect(result.content).toEqual([{ type: 'redacted_thinking', data: expect.any(String) }]);
    expect(result.stop_reason).toBe('refusal');
    expect(result.stop_details).toEqual({ type: 'refusal', category, explanation: 'Classifier declined.' });
  });
  test(`${code} becomes a GenerateContent safety termination`, async () => {
    const frames = await collect(generateContentViaResponses(iterate([eventFrame({ type: 'response.failed', response: { id: 'resp_policy', model: 'served', output: [], status: 'failed', error: { code, message: 'Classifier declined.' } } })] as any), createTestSidecarCodec()));
    expect(frames.at(-1)).toMatchObject({ event: { candidates: [{ finishReason: 'SAFETY', finishMessage: 'Classifier declined.' }] } });
  });
}

test.each(['The safety policy service is unavailable.'])('a server error stays an error regardless of message keywords: %s', async message => {
  const frames = await collect(generateContentViaResponses(iterate([eventFrame({ type: 'response.failed', response: { id: 'resp_failed', model: 'served', output: [], status: 'failed', error: { code: 'server_error', message } } })] as any), createTestSidecarCodec()));
  expect(frames).toEqual([eventFrame({ error: { code: 500, status: 'INTERNAL', message, details: [{ '@type': 'type.googleapis.com/google.protobuf.Struct', value: { code: 'server_error' } }] } })]);
});

test('a failed Responses stream without an error description still fails with a message', async () => {
  const frames = await collect(generateContentViaResponses(iterate([eventFrame({ type: 'response.failed', response: { id: 'resp_failed', model: 'served', output: [], status: 'failed', error: null } })] as any), createTestSidecarCodec()));
  expect(frames).toEqual([eventFrame({ error: { code: 500, status: 'INTERNAL', message: 'Response failed due to unknown error.' } })]);
});

test('ChatCompletions rejects generated content before any non-empty model', async () => {
  await expect(collectIR(readOpenAIChatCompletionsEvents(iterate([
    eventFrame({ id: '', object: '', created: 0, model: '', choices: [] } as any),
    eventFrame({ id: '', object: '', created: 0, model: '', choices: [{ index: 0, delta: { content: 'answer' }, finish_reason: null }] } as any),
  ])))).rejects.toThrow('before a non-empty model');
});

test('ChatCompletions role-only choices still require finish_reason without creating output IR records', async () => {
  const role = eventFrame({ id: 'chat_role', model: 'served', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] } as any);
  await expect(collectIR(readOpenAIChatCompletionsEvents(iterate([role])))).rejects.toThrow('ended without finish_reason');

  let reached!: () => void;
  let release!: () => void;
  const atGate = new Promise<void>(resolve => { reached = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const source = async function* () {
    yield role;
    reached();
    await gate;
    yield eventFrame({ id: 'chat_role', model: 'served', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] } as any);
  };
  const output: any[] = [];
  const run = (async () => { for await (const record of readOpenAIChatCompletionsEvents(source())) output.push(record); })();
  await atGate;
  expect(output.some(record => record.type === 'write' && record.path[0] === 'choices')).toBe(false);
  release();
  await run;
});

test('Messages message_start requires a string model', async () => {
  const message = { id: 'msg', model: 42, content: [], usage: { input_tokens: 0, output_tokens: 0 } };
  await expect(collectIR(readAnthropicMessagesEvents(iterate([
    eventFrame({ type: 'message_start', message } as any),
  ])))).rejects.toThrow('requires a model');
});

test('Messages takes tool input only from input_json_delta', async () => {
  const ir = await collectIR(readAnthropicMessagesEvents(iterate([
    eventFrame({ type: 'message_start', message: { id: 'msg', model: 'claude-test', content: [], usage: { input_tokens: 0, output_tokens: 0 } } } as any),
    eventFrame({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call', name: 'lookup', input: { ignored: true } } } as any),
    eventFrame({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"q":1}' } } as any),
    eventFrame({ type: 'content_block_stop', index: 0 } as any),
    eventFrame({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } } as any),
    eventFrame({ type: 'message_stop' } as any),
  ])));
  expect(ir.choices[0].items).toEqual([{ type: 'function_call', call_id: 'call', name: 'lookup', arguments: '{"q":1}' }]);
});

test('ChatCompletions choice indexes must arrive in sequence', async () => {
  // Choice indexes open consecutively from zero; opening choice 1 first leaves a gap.
  await expect(collectIR(readOpenAIChatCompletionsEvents(iterate([
    eventFrame({ id: 'chat_choices', model: 'served', choices: [{ index: 1, delta: {}, finish_reason: 'stop' }] } as any),
  ])))).rejects.toThrow('out of sequence');
});

test('Responses rejects output events before the initial envelope', async () => {
  await expect(collectIR(readOpenAIResponsesEvents(iterate([
    eventFrame({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg', role: 'assistant', content: [] } } as any),
  ])))).rejects.toThrow('before the initial response envelope');
});

test('Messages and GenerateContent reject custom tool calls they cannot represent', async () => {
  const frames = completeIR([{ type: 'custom_tool_call', call_id: 'call_custom', name: 'run_code', input: 'input' }]);
  await expect(collect(writeAnthropicMessagesEvents(iterate(frames)))).rejects.toThrow('cannot represent custom tool calls');
  await expect(collect(writeGeminiGenerateContentEvents(iterate(frames)))).rejects.toThrow('cannot represent custom tool calls');
});

test('single-choice writers reject a second choice when it is initialized', async () => {
  const b = createIRBuilder();
  b.assign(['model'], 'model');
  b.event({ type: 'start', id: 'source' });
  b.choice(0);
  b.choice(1);
  const frames = [...b.drain()];
  await expect(collect(writeAnthropicMessagesEvents(iterate(frames)))).rejects.toThrow('cannot represent multiple choices');
  await expect(collect(writeOpenAIResponsesEvents(iterate(frames)))).rejects.toThrow('cannot represent multiple choices');
});

test('an upstream context failure retains the Messages prompt-too-long response', async () => {
  const frames = await collect(messagesViaResponses(iterate([eventFrame({ type: 'response.failed', response: { error: { code: 'context_length_exceeded', message: 'Context exceeded.' } } })] as any), createTestSidecarCodec()));
  expect(frames).toMatchObject([{ event: { type: 'error', error: { type: 'invalid_request_error', message: expect.stringContaining('prompt is too long') } } }]);
});

test.each([{ input: 'print(1)' }, { other: 1 }])('Responses via Messages restores wrapped custom input %j', async wrapped => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const frames = fixtureFrames('anthropic-messages', { tools: [{ name: 'run_code', id: 'call_custom', args: wrapped }] });
    const result = await nativeResult('openai-responses', await collect(responsesViaMessages(iterate(frames), new Set(['run_code']), createTestSidecarCodec())));
    expect(result.output.slice(0, -1)).toEqual([expect.objectContaining({ type: 'custom_tool_call', call_id: 'call_custom', name: 'run_code', input: 'input' in wrapped ? wrapped.input : JSON.stringify(wrapped) })]);
    expect(warning).toHaveBeenCalledTimes('input' in wrapped ? 0 : 1);
  } finally { warning.mockRestore(); }
});

test.each([messagesViaChat, generateContentViaChat])('completed empty function JSON is rejected by object-requiring destinations', async translate => {
  const frames = fixtureFrames('openai-chat-completions', { tools: [{ name: 'lookup', id: 'call_empty', args: {} }] });
  for (const frame of frames) if (frame.type === 'event') for (const choice of frame.event.choices) for (const call of choice.delta.tool_calls ?? []) if (call.function.arguments !== undefined) call.function.arguments = '';
  await expect(collect<any>(translate(iterate(frames), createTestSidecarCodec()))).rejects.toThrow();
});

test.each([
  ['{"x":42,', { x: 42 }, 'length'],
] as const)('Messages collects %j as %j and replays original Chat arguments on %s', async (arguments_, input, stop) => {
  const codec = createTestSidecarCodec();
  const frames = fixtureFrames('openai-chat-completions', { tools: [{ name: 'lookup', id: 'call_partial', args: {} }], stop });
  for (const frame of frames) if (frame.type === 'event') for (const choice of frame.event.choices) for (const call of choice.delta.tool_calls ?? []) if (call.function.arguments !== undefined) call.function.arguments = call.function.name === undefined ? arguments_.slice(2) : arguments_.slice(0, 2);
  const result = await nativeResult('anthropic-messages', await collect(messagesViaChat(iterate(frames), codec)));
  expect(result.content[0]).toMatchObject({ type: 'tool_use', input });
  expect(result.stop_reason).toBe(stop === 'length' ? 'max_tokens' : 'tool_use');
  const request = await messagesRequestViaChat({ model: 'model', max_tokens: 100, stream: true, messages: [{ role: 'assistant', content: result.content }] }, codec);
  expect(request.messages).toMatchObject([{ role: 'assistant', tool_calls: [{ id: 'call_partial', function: { name: 'lookup', arguments: arguments_ } }] }]);
});

test('ignores vendor object arrays and retains scalar reasoning items', async () => {
  const frames = fixtureFrames('openai-chat-completions', { thinking: ['ab'], text: ['answer'] });
  const records = [{ type: 'vendor_record', id: 'record_a', segments: ['a'] }, { type: 'vendor_record', id: 'record_b', segments: ['b'] }];
  frames.splice(-1, 0, eventFrame({ id: 'chatcmpl_test', model: 'served-model', created: 100, choices: [{ index: 0, delta: { vendor_records: records }, finish_reason: null }] }));
  const ir = await collectIR(irFromOpenAIChatCompletionsProduction(iterate(frames), { roundTrip: createRoundTripReaderCapture().roundTrip }));
  expect(ir.choices[0].items.filter(item => item.type === 'reasoning')).toEqual([{ type: 'reasoning', summary: ['ab'] }]);
  const result = await nativeResult('openai-responses', await collect(responsesViaChat(iterate(frames), new Set(), createTestSidecarCodec())));
  expect(result.output.filter((item: any) => item.type === 'reasoning' && item.encrypted_content === undefined)).toMatchObject([{ summary: [{ text: 'ab' }] }]);
  expect(result.output.some((item: any) => ['record_a', 'record_b'].includes(item.id))).toBe(false);
  expect(result.output.filter((item: any) => item.type === 'message')[0].content[0].text).toBe('answer');
});

for (const category of ['cyber']) {
  test.each([' \t\n', '  Original spacing.  '])(`Responses via Messages preserves nonblank ${category} explanations and supplies a native error message when absent: %j`, async explanation => {
    const frames = fixtureFrames('anthropic-messages', { stop: 'content_filter' });
    for (const frame of frames) if (frame.type === 'event' && frame.event.type === 'message_delta') frame.event.delta.stop_details = { type: 'refusal', category, explanation };
    const output = await collect(responsesViaMessages(iterate(frames), new Set(), createTestSidecarCodec()));
    expect(output.at(-1)).toMatchObject({
      event: {
        type: 'response.failed',
        response: {
          error: {
            code: `${category}_policy`,
            message: explanation == null || explanation.trim() === '' ? `The upstream declined this request under the ${category} policy category.` : explanation,
          },
        },
      },
    });
  });
}
