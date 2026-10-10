import { Hono } from 'hono';
import { expect, test } from 'vitest';

import { analyzeAnthropicMessagesAffinity } from '../../../../../src/data-plane/chat/anthropic-messages/affinity/ingress.ts';
import { respondAnthropicMessages } from '../../../../../src/data-plane/chat/anthropic-messages/respond.ts';
import { analyzeGeminiGenerateContentAffinity } from '../../../../../src/data-plane/chat/gemini-generate-content/affinity/ingress.ts';
import { respondGeminiGenerateContent } from '../../../../../src/data-plane/chat/gemini-generate-content/respond.ts';
import { analyzeOpenAIChatCompletionsAffinity } from '../../../../../src/data-plane/chat/openai-chat-completions/affinity/ingress.ts';
import { respondOpenAIChatCompletions } from '../../../../../src/data-plane/chat/openai-chat-completions/respond.ts';
import { analyzeOpenAIResponsesAffinity } from '../../../../../src/data-plane/chat/openai-responses/affinity/ingress.ts';
import { respondOpenAIResponses } from '../../../../../src/data-plane/chat/openai-responses/respond.ts';
import { createAssistantTurnSidecarCodec } from '../../../../../src/data-plane/chat/shared/assistant-turn-sidecar/codec.ts';
import { initRepo } from '../../../../../src/repo/index.ts';
import { InMemoryRepo } from '../../../../repo/memory.ts';
import { mockChatGatewayCtx } from '../../../../test-utils/gateway-ctx.ts';
import { collectAnthropicMessagesProtocolEventsToResult } from '@floway-dev/protocols/anthropic-messages';
import { doneFrame, encodeBase64, eventFrame, parseSSEStream, type ProtocolFrame } from '@floway-dev/protocols/common';
import { collectGeminiGenerateContentProtocolEventsToResult } from '@floway-dev/protocols/gemini-generate-content';
import { collectOpenAIChatCompletionsProtocolEventsToResult } from '@floway-dev/protocols/openai-chat-completions';
import { collectOpenAIResponsesProtocolEventsToResult, openaiResponsesResultToEvents } from '@floway-dev/protocols/openai-responses';
import { eventResult } from '@floway-dev/provider';
import { stubModelCandidate, testTelemetryModelIdentity } from '@floway-dev/test-utils';
import {
  translateAnthropicMessagesViaOpenAIChatCompletions,
  translateAnthropicMessagesViaOpenAIResponses,
  translateGeminiGenerateContentViaAnthropicMessages,
  translateGeminiGenerateContentViaOpenAIChatCompletions,
  translateGeminiGenerateContentViaOpenAIResponses,
  translateOpenAIChatCompletionsViaAnthropicMessages,
  translateOpenAIChatCompletionsViaOpenAIResponses,
  translateOpenAIResponsesViaAnthropicMessages,
  translateOpenAIResponsesViaOpenAIChatCompletions,
} from '@floway-dev/translate';

type Wire = Record<string, any>;
type Protocol = 'chat' | 'responses' | 'messages' | 'gemini';
const codec = createAssistantTurnSidecarCodec({ serverSecret: 'round-trip-test-secret' });
const ctx = { model: 'm', assistantTurnSidecar: codec, loadRemoteImage: async () => { throw new Error('Unexpected remote image'); } };
const iterate = async function* (frames: ProtocolFrame<any>[]) { yield* frames; };
const framesFor = (protocol: Protocol, argumentsText = '{ "x": 1 }', text = 'onetwo'): ProtocolFrame<any>[] => {
  if (protocol === 'chat') {
    const chunk = (delta: Wire, finish_reason: string | null = null) => eventFrame({ id: 'chat', object: 'chat.completion.chunk', model: 'm', created: 1, choices: [{ index: 0, delta, finish_reason }] });
    return [chunk({ role: 'assistant', reasoning_text: 'reason', reasoning_opaque: 'native-ciphertext' }), chunk({ content: text.slice(0, 3) }), chunk({ content: text.slice(3), tool_calls: [{ index: 0, id: 'call', type: 'function', function: { name: 'lookup', arguments: argumentsText.slice(0, 6) } }] }), chunk({ tool_calls: [{ index: 0, function: { arguments: argumentsText.slice(6) } }] }), chunk({}, 'tool_calls'), doneFrame()];
  }
  if (protocol === 'responses') return openaiResponsesResultToEvents({ id: 'resp', object: 'response', model: 'm', created_at: 1, status: 'completed', error: null, incomplete_details: null, output: [{ type: 'reasoning', id: 'rs', summary: [{ type: 'summary_text', text: 'reason' }], encrypted_content: 'native-ciphertext' }, { type: 'message', id: 'msg', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }, { type: 'function_call', id: 'fc', call_id: 'call', name: 'lookup', arguments: argumentsText, status: 'completed' }] } as any);
  return [
    eventFrame({ type: 'message_start', message: { id: 'msg', type: 'message', role: 'assistant', model: 'm', content: [], usage: { input_tokens: 1, output_tokens: 0 } } }),
    eventFrame({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 'reason', signature: 'native-ciphertext' } }), eventFrame({ type: 'content_block_stop', index: 0 }),
    eventFrame({ type: 'content_block_start', index: 1, content_block: { type: 'text', text, citations: null } }), eventFrame({ type: 'content_block_stop', index: 1 }),
    eventFrame({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'call', name: 'lookup', input: {} } }), eventFrame({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: argumentsText } }), eventFrame({ type: 'content_block_stop', index: 2 }),
    eventFrame({ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 1 } }), eventFrame({ type: 'message_stop' }),
  ];
};
const collectNative = async (protocol: Protocol, frames: AsyncIterable<ProtocolFrame<any>>): Promise<Wire> => {
  if (protocol === 'chat') return await collectOpenAIChatCompletionsProtocolEventsToResult(frames);
  if (protocol === 'responses') return await collectOpenAIResponsesProtocolEventsToResult(frames);
  if (protocol === 'messages') return await collectAnthropicMessagesProtocolEventsToResult(frames);
  return await collectGeminiGenerateContentProtocolEventsToResult(frames);
};
const payloadFor = (protocol: Protocol, turn?: Wire | Wire[]): any => {
  if (protocol === 'chat') return { model: 'm', messages: turn === undefined ? [{ role: 'user', content: 'hi' }] : [turn] };
  if (protocol === 'responses') return { model: 'm', input: turn ?? [{ type: 'message', role: 'user', content: 'hi' }] };
  if (protocol === 'messages') return { model: 'm', max_tokens: 32, messages: turn === undefined ? [{ role: 'user', content: 'hi' }] : [turn] };
  return { contents: turn ?? [{ role: 'user', parts: [{ text: 'hi' }] }] };
};
const historyTurn = (protocol: Protocol, result: Wire): any => {
  if (protocol === 'chat') { const { annotations: _annotations, ...message } = result.choices[0].message; return message; }
  if (protocol === 'responses') return result.output.map((item: Wire) => item.type === 'message' ? { ...item, content: item.content.map(({ annotations: _annotations, logprobs: _logprobs, ...part }: Wire) => part) } : item);
  if (protocol === 'messages') return { role: 'assistant', content: result.content };
  return result.candidates.map((candidate: Wire) => candidate.content);
};
const targetHistory = (protocol: Protocol, target: Wire): any => protocol === 'responses' ? target.input : target.messages[0];
const nativeCarrier = (protocol: Protocol, turn: any): string[] => {
  if (protocol === 'chat') return (turn.reasoning_details ?? []).flatMap((item: Wire) => item.type === 'reasoning.encrypted' ? [item.data] : []);
  if (protocol === 'responses') return turn.flatMap((item: Wire) => item.type === 'reasoning' && item.encrypted_content !== undefined ? [item.encrypted_content] : []);
  if (protocol === 'messages') return turn.content.flatMap((block: Wire) => block.type === 'redacted_thinking' ? [block.data] : []);
  return turn.flatMap((content: Wire) => content.parts.flatMap((part: Wire) => part.thoughtSignature === undefined ? [] : [part.thoughtSignature]));
};
const pairs = [
  ['chat', 'messages', translateOpenAIChatCompletionsViaAnthropicMessages], ['chat', 'responses', translateOpenAIChatCompletionsViaOpenAIResponses],
  ['responses', 'messages', translateOpenAIResponsesViaAnthropicMessages], ['responses', 'chat', translateOpenAIResponsesViaOpenAIChatCompletions],
  ['messages', 'responses', translateAnthropicMessagesViaOpenAIResponses], ['messages', 'chat', translateAnthropicMessagesViaOpenAIChatCompletions],
  ['gemini', 'messages', translateGeminiGenerateContentViaAnthropicMessages], ['gemini', 'responses', translateGeminiGenerateContentViaOpenAIResponses], ['gemini', 'chat', translateGeminiGenerateContentViaOpenAIChatCompletions],
] as const;
const sourceNames = { chat: 'openaiChatCompletions', responses: 'openaiResponses', messages: 'anthropicMessages', gemini: 'geminiGenerateContent' };

test.each(pairs)('%s via %s restores native history through the signed runtime sidecar', async (source, target, translate) => {
  const trip = await translate(payloadFor(source), ctx);
  const replayTurn = historyTurn(source, await collectNative(source, trip.events(iterate(framesFor(target)))));
  const carriers = nativeCarrier(source, replayTurn);
  expect(carriers).toHaveLength(1);
  expect(carriers[0]).not.toBe('native-ciphertext');
  expect(JSON.stringify(replayTurn)).not.toContain('native-ciphertext');
  const sidecar = await codec.unencapsulate(sourceNames[source], carriers[0]) as Wire;
  expect(sidecar.referencedContents.length).toBeGreaterThan(0);
  expect(JSON.stringify(sidecar.thinAssistantTurn)).toContain('native-ciphertext');
  const replay = await translate(payloadFor(source, replayTurn), ctx);
  expect(targetHistory(target, replay.target)).toEqual(historyTurn(target, await collectNative(target, iterate(framesFor(target)))));
});

const appendBody = (protocol: Protocol, turn: any): void => {
  if (protocol === 'chat') turn.content += 'added';
  else if (protocol === 'responses') turn.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'added' }] });
  else if (protocol === 'messages') turn.content.push({ type: 'text', text: 'added' });
  else turn[0].parts.push({ text: 'added' });
};
const toolIn = (protocol: Protocol, turn: any): Wire => {
  if (protocol === 'chat') return turn.tool_calls[0];
  if (protocol === 'responses') return turn.find((item: Wire) => item.type === 'function_call');
  if (protocol === 'messages') return turn.content.find((block: Wire) => block.type === 'tool_use');
  return turn[0].parts.find((part: Wire) => part.functionCall !== undefined).functionCall;
};
const replaceCarrier = (protocol: Protocol, turn: any, data: string): void => {
  if (protocol === 'chat') turn.reasoning_details.find((item: Wire) => item.type === 'reasoning.encrypted').data = data;
  else if (protocol === 'responses') turn.find((item: Wire) => item.type === 'reasoning' && item.encrypted_content !== undefined).encrypted_content = data;
  else if (protocol === 'messages') turn.content.find((block: Wire) => block.type === 'redacted_thinking').data = data;
  else turn.flatMap((content: Wire) => content.parts).find((part: Wire) => part.thoughtSignature !== undefined).thoughtSignature = data;
};
const duplicateCarrier = (protocol: Protocol, turn: any): void => {
  if (protocol === 'chat') turn.reasoning_details.push({ ...turn.reasoning_details.find((item: Wire) => item.type === 'reasoning.encrypted') });
  else if (protocol === 'responses') turn.push({ ...turn.find((item: Wire) => item.type === 'reasoning' && item.encrypted_content !== undefined), id: 'duplicate' });
  else if (protocol === 'messages') turn.content.push({ ...turn.content.find((block: Wire) => block.type === 'redacted_thinking') });
  else turn[0].parts.push({ thoughtSignature: nativeCarrier(protocol, turn)[0] });
};
const removeCarrier = (protocol: Protocol, turn: any): void => {
  if (protocol === 'chat') delete turn.reasoning_details;
  else if (protocol === 'responses') turn.splice(turn.findIndex((item: Wire) => item.type === 'reasoning' && item.encrypted_content !== undefined), 1);
  else if (protocol === 'messages') turn.content = turn.content.filter((block: Wire) => block.type !== 'redacted_thinking');
  else turn[0].parts = turn[0].parts.filter((part: Wire) => part.thoughtSignature === undefined);
};
const mutationCases = ['added-body', 'tool-name', 'tool-id', 'tool-arguments', 'reordered-body', 'multiple-sidecars', 'missing-sidecar', 'unknown-check-version', 'wrong-target', 'missing-reference', 'invalid-signature'] as const;
const replayCases = pairs.flatMap(([source, target, translate]) => mutationCases.map(mutation => ({ source, target, translate, mutation })));

test.each(replayCases)('$source via $target uses the whole cleaned bare turn after $mutation', async ({ source, target, translate, mutation }) => {
  const trip = await translate(payloadFor(source), ctx);
  const turn = historyTurn(source, await collectNative(source, trip.events(iterate(framesFor(target)))));
  if (mutation === 'added-body') appendBody(source, turn);
  else if (mutation === 'tool-name') {
    const tool = toolIn(source, turn);
    if (source === 'chat') tool.function.name = 'changed';
    else tool.name = 'changed';
  } else if (mutation === 'tool-id') {
    const tool = toolIn(source, turn);
    if (source === 'responses') tool.call_id = 'changed';
    else tool.id = 'changed';
  } else if (mutation === 'reordered-body') {
    appendBody(source, turn);
    if (source === 'chat') turn.content = 'addedonetwo';
    else if (source === 'responses') turn.unshift(turn.pop());
    else if (source === 'messages') turn.content.unshift(turn.content.pop());
    else turn[0].parts.unshift(turn[0].parts.pop());
  } else if (mutation === 'tool-arguments') {
    const tool = toolIn(source, turn);
    if (source === 'chat') tool.function.arguments = '{"changed":true}';
    else if (source === 'responses') tool.arguments = '{"changed":true}';
    else if (source === 'messages') tool.input = { changed: true };
    else tool.args = { changed: true };
  } else if (mutation === 'multiple-sidecars') duplicateCarrier(source, turn);
  else if (mutation === 'missing-sidecar') removeCarrier(source, turn);
  else if (mutation === 'unknown-check-version' || mutation === 'wrong-target' || mutation === 'missing-reference') {
    const sidecar = await codec.unencapsulate(sourceNames[source], nativeCarrier(source, turn)[0]) as Wire;
    if (mutation === 'unknown-check-version') sidecar.replayCheck.version++;
    else if (mutation === 'wrong-target') sidecar.target = sourceNames[source];
    else sidecar.referencedContents[0][0] ^= 0xff;
    replaceCarrier(source, turn, await codec.encapsulate(sourceNames[source], sidecar));
  } else replaceCarrier(source, turn, encodeBase64(new Uint8Array(32)));
  const replay = await translate(payloadFor(source, turn), ctx);
  const body = JSON.stringify(replay.target);
  expect(body).not.toContain('native-ciphertext');
  expect(body).not.toContain('reasoning_details');
  expect(body).not.toContain('invalid-signature');
  if (mutation === 'added-body') expect(body).toContain('added');
  if (mutation === 'tool-name') expect(body).toContain('changed');
  if (mutation === 'tool-arguments') expect(body).toContain('changed');
  if (mutation === 'tool-id') expect(body).toContain('changed');
  if (mutation === 'reordered-body') expect(body).toContain('added');
});

test.each(pairs.filter(([source]) => source === 'gemini'))('%s via %s accepts its sidecar attached to meaningful content and keeps that content on bare fallback', async (source, target, translate) => {
  const trip = await translate(payloadFor(source), ctx);
  const turn = historyTurn(source, await collectNative(source, trip.events(iterate(framesFor(target)))));
  const carrier = nativeCarrier(source, turn)[0];
  removeCarrier(source, turn);
  turn[0].parts.find((part: Wire) => part.text === 'onetwo').thoughtSignature = carrier;
  const restored = await translate(payloadFor(source, turn), ctx);
  expect(targetHistory(target, restored.target)).toEqual(historyTurn(target, await collectNative(target, iterate(framesFor(target)))));
  appendBody(source, turn);
  const bare = await translate(payloadFor(source, turn), ctx);
  expect(JSON.stringify(bare.target)).toContain('onetwo');
  expect(JSON.stringify(bare.target)).toContain('added');
  expect(JSON.stringify(bare.target)).not.toContain(carrier);
});

const rawJSON = JSON as typeof JSON & { isRawJSON: (value: unknown) => boolean };
test.each(pairs)('%s via %s preserves numeric tokens, lone surrogates and literal prototype keys in the runtime round trip', async (source, target, translate) => {
  const argumentsText = '{"huge":900719925474099312345,"overflow":1e999,"\\ud800":"😀\\ud800","__proto__":{"value":true}}';
  const text = 'A😀\ud800Z';
  const trip = await translate(payloadFor(source), ctx);
  const turn = historyTurn(source, await collectNative(source, trip.events(iterate(framesFor(target, argumentsText, text)))));
  const replay = await translate(payloadFor(source, turn), ctx);
  const history = targetHistory(target, replay.target);
  expect(JSON.stringify(history)).toContain(JSON.stringify(text));
  if (target === 'messages') {
    const input = history.content.find((block: Wire) => block.type === 'tool_use').input;
    expect(rawJSON.isRawJSON(input.huge)).toBe(true);
    expect(rawJSON.isRawJSON(input.overflow)).toBe(true);
    expect(JSON.stringify(input)).toBe(argumentsText);
    expect(Object.hasOwn(input, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(input)).toBe(Object.prototype);
  } else if (target === 'responses') expect(history.find((item: Wire) => item.type === 'function_call').arguments).toBe(argumentsText);
  else expect(history.tool_calls[0].function.arguments).toBe(argumentsText);
});

test('a selected Gemini candidate restores its own Chat Completions choice when choices finish together', async () => {
  const trip = await translateGeminiGenerateContentViaOpenAIChatCompletions(payloadFor('gemini'), ctx);
  const chunk = (choices: Wire[]) => eventFrame({ id: 'chat', object: 'chat.completion.chunk', model: 'm', created: 1, choices });
  const frames = [
    chunk([{ index: 0, delta: { role: 'assistant', content: 'first' }, finish_reason: null }, { index: 1, delta: { role: 'assistant', content: 'second' }, finish_reason: null }]),
    chunk([{ index: 0, delta: {}, finish_reason: 'stop' }, { index: 1, delta: {}, finish_reason: 'stop' }]), doneFrame(),
  ];
  const result = await collectNative('gemini', trip.events(iterate(frames)));
  for (const candidate of result.candidates) {
    const replay = await translateGeminiGenerateContentViaOpenAIChatCompletions(payloadFor('gemini', [candidate.content]), ctx);
    expect(replay.target.messages).toEqual([{ role: 'assistant', content: candidate.index === 0 ? 'first' : 'second', refusal: null }]);
  }
});

test.each(pairs)('%s via %s translates user turns without inspecting a sidecar', async (source, _target, translate) => {
  const trip = await translate(payloadFor(source), {
    ...ctx,
    assistantTurnSidecar: { ...codec, unencapsulate: async () => { throw new Error('A user turn must use bare translation'); } },
  });
  expect(JSON.stringify(trip.target)).toContain('hi');
});

const responderCases = pairs.flatMap(([source, target, translate]) => [false, true].map(stream => ({ source, target, translate, stream })));

test.each(responderCases)('$source via $target survives the real HTTP output boundary (stream=$stream)', async ({ source, target, translate, stream }) => {
  initRepo(new InMemoryRepo());
  const trip = await translate(payloadFor(source), ctx);
  const gatewayCtx = mockChatGatewayCtx({ assistantTurnSidecar: codec, wantsStream: stream });
  const candidate = stubModelCandidate({ model: { endpoints: { [sourceNames[target]]: {} } } });
  gatewayCtx.affinity.select(candidate);
  const result = eventResult<ProtocolFrame<any>>(trip.events(iterate(framesFor(target))), testTelemetryModelIdentity);
  const app = new Hono();
  app.get('/', async c => {
    if (source === 'chat') return await respondOpenAIChatCompletions(c, result as any, stream, false, gatewayCtx);
    if (source === 'messages') return await respondAnthropicMessages(c, result as any, stream, gatewayCtx);
    if (source === 'gemini') return await respondGeminiGenerateContent(c, result as any, stream, gatewayCtx);
    return await respondOpenAIResponses(c, result as any, stream, gatewayCtx, payloadFor(source));
  });
  const response = await app.request('/');
  expect(response.status).toBe(200);
  const parsedFrames = async function* () {
    for await (const frame of parseSSEStream(response.body!)) {
      if (frame.data === '[DONE]') yield doneFrame();
      else yield eventFrame(JSON.parse(frame.data));
    }
  };
  const emitted = stream ? await collectNative(source, parsedFrames()) : await response.json() as Wire;
  const replayTurn = historyTurn(source, emitted);
  const carriers = nativeCarrier(source, replayTurn);
  expect(carriers).toHaveLength(1);
  const domains = {
    chat: 'openai-chat-completions.reasoning_details.reasoning.encrypted.data',
    responses: 'openai-responses.reasoning.encrypted_content',
    messages: 'anthropic-messages.redacted_thinking.data',
    gemini: 'gemini-generate-content.part.thoughtSignature',
  };
  const outer = await gatewayCtx.affinity.codec.unwrap(carriers[0], domains[source]);
  expect(outer.kind).toBe('owned');
  if (outer.kind !== 'owned') throw new Error('Affinity did not wrap the emitted sidecar');
  expect(await codec.unencapsulate(sourceNames[source], outer.value)).toBeDefined();
  if (source === 'responses') expect(replayTurn.at(-1).type).toBe('reasoning');
  if (source === 'messages') expect(replayTurn.content.at(-1).type).toBe('redacted_thinking');
  if (source === 'gemini') expect(Object.keys(replayTurn.at(-1).parts.at(-1))).toEqual(['thoughtSignature']);
  if (source === 'chat') expect(replayTurn.reasoning_opaque).toBeUndefined();
  if (source === 'messages') expect(replayTurn.content.filter((block: Wire) => block.type === 'thinking').every((block: Wire) => block.signature === '')).toBe(true);
  const payload = payloadFor(source, replayTurn);
  const analysis = source === 'chat' ? await analyzeOpenAIChatCompletionsAffinity(payload, gatewayCtx.affinity.codec)
    : source === 'messages' ? await analyzeAnthropicMessagesAffinity(payload, gatewayCtx.affinity.codec)
      : source === 'gemini' ? await analyzeGeminiGenerateContentAffinity(payload, gatewayCtx.affinity.codec)
        : await analyzeOpenAIResponsesAffinity(payload, gatewayCtx.affinity.codec);
  const evaluation = analysis.evaluateCandidate(candidate);
  expect(evaluation.kind).toBe('accepted');
  if (evaluation.kind !== 'accepted') throw new Error('Replay candidate rejected');
  const replay = await translate(evaluation.materialize() as any, ctx);
  const original = historyTurn(target, await collectNative(target, iterate(framesFor(target))));
  expect(targetHistory(target, replay.target)).toEqual(original);
});
