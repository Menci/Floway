import { expect, test } from 'vitest';

import { requireTrip } from './require-trip.ts';
import type { IRErrorPayload } from '../../src/ir/types.ts';
import { irFromAnthropicMessages } from '../../src/protocols/anthropic-messages/as-target/sse-from.ts';
import { irFromOpenAIChatCompletions } from '../../src/protocols/openai-chat-completions/as-target/sse-from.ts';
import { irFromOpenAIResponses } from '../../src/protocols/openai-responses/as-target/sse-from.ts';
import { collect, iterate } from '../ir/helpers.ts';
import { createTestSidecarCodec } from '../round-trip/sidecar-codec.ts';
import { createRoundTripReaderCapture } from '../round-trip/test-helpers.ts';
import { PROMPT_TOO_LONG_MESSAGE } from '@floway-dev/protocols/anthropic-messages';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import {
  routeAnthropicMessagesViaOpenAIChatCompletions,
  routeAnthropicMessagesViaOpenAIResponses,
  routeGeminiGenerateContentViaAnthropicMessages,
  routeGeminiGenerateContentViaOpenAIChatCompletions,
  routeGeminiGenerateContentViaOpenAIResponses,
  routeOpenAIChatCompletionsViaAnthropicMessages,
  routeOpenAIChatCompletionsViaOpenAIResponses,
  routeOpenAIResponsesViaAnthropicMessages,
  routeOpenAIResponsesViaOpenAIChatCompletions,
  type TranslateInputError,
  type TranslateTrip,
} from '@floway-dev/translate';

const options = () => ({ model: 'm', sidecarCodec: createTestSidecarCodec('error-routes') });
const chat = { model: 'm', messages: [{ role: 'user' as const, content: 'hello' }] };
const responses = { model: 'm', input: 'hello' };
const messages = { model: 'm', max_tokens: 16, messages: [{ role: 'user' as const, content: 'hello' }] };
const gemini = { contents: [{ role: 'user' as const, parts: [{ text: 'hello' }] }] };

const failure = {
  message: 'bad field', type: 'invalid_request_error', code: 'invalid_prompt', param: 'temperature',
  status: 'UPSTREAM_STATUS', msg: 'secondary message', retry_after: 7,
  provider_specific_fields: { request_id: 'req_1', retry_after: 9 },
};
const chatEvent = (error: IRErrorPayload) => ({
  id: 'error', object: 'chat.completion.chunk' as const, created: 0, model: 'm', choices: [], error,
});
const nestedEvent = (error: typeof failure) => ({ type: 'error' as const, error });

const expectedChat = {
  error: {
    message: failure.message, type: failure.type, code: failure.code, param: failure.param,
    provider_specific_fields: { status: failure.status, msg: failure.msg, request_id: 'req_1', retry_after: 9 },
  },
};
const expectedResponses = {
  type: 'error', message: failure.message, code: failure.code, param: failure.param,
  provider_specific_fields: { type: failure.type, status: failure.status, msg: failure.msg, request_id: 'req_1', retry_after: 9 },
};
const expectedMessages = {
  type: 'error', error: {
    type: failure.type, message: failure.message,
    provider_specific_fields: { code: failure.code, param: failure.param, status: failure.status, msg: failure.msg, request_id: 'req_1', retry_after: 9 },
  },
};
const expectedGemini = {
  error: {
    code: 400, status: 'INVALID_ARGUMENT', message: failure.message,
    details: [{
      '@type': 'type.googleapis.com/google.protobuf.Struct', value: {
        type: failure.type, code: failure.code, param: failure.param, status: failure.status,
        msg: failure.msg, request_id: 'req_1', retry_after: 9,
      },
    }],
  },
};

const verifyPhases = async <Payload, Source, Target>(
  pending: Promise<TranslateTrip<Payload, Source, Target> | TranslateInputError>,
  event: Target,
  expected: unknown,
) => {
  const trip = await requireTrip(pending);
  const headers = new Headers({
    'content-type': 'text/plain', 'content-length': '123', 'content-encoding': 'gzip',
    'retry-after': '5', 'x-request-id': 'req_1',
  });
  const http = trip.error(400, headers, new TextEncoder().encode(JSON.stringify({ error: failure })));
  expect(http?.status).toBe(400);
  expect(http?.body).toEqual(expected);
  expect(http?.headers.get('retry-after')).toBe('5');
  expect(http?.headers.get('x-request-id')).toBe('req_1');
  expect(http?.headers.get('content-type')).toBe('application/json');
  expect(http?.headers.has('content-length')).toBe(false);
  expect(http?.headers.has('content-encoding')).toBe(false);
  expect(headers.get('content-type')).toBe('text/plain');
  const frames = await collect(trip.events(iterate([eventFrame(event)])));
  expect(frames).toHaveLength(1);
  const [frame] = frames;
  if (frame.type !== 'event') throw new Error('Expected the translated error event');
  const source = frame.event as Record<string, unknown>;
  const { sequence_number: _sequenceNumber, ...body } = source;
  expect(body).toEqual(expected);
};

const cases = [
  ['Chat via Responses', () => verifyPhases(routeOpenAIChatCompletionsViaOpenAIResponses(chat, options()), nestedEvent(failure), expectedChat)],
  ['Chat via Messages', () => verifyPhases(routeOpenAIChatCompletionsViaAnthropicMessages(chat, { ...options(), loadRemoteImage: async () => null, fallbackMaxOutputTokens: 16 }), nestedEvent(failure), expectedChat)],
  ['Responses via Chat', () => verifyPhases(routeOpenAIResponsesViaOpenAIChatCompletions(responses, options()), chatEvent(failure), expectedResponses)],
  ['Responses via Messages', () => verifyPhases(routeOpenAIResponsesViaAnthropicMessages(responses, { ...options(), loadRemoteImage: async () => null, fallbackMaxOutputTokens: 16 }), nestedEvent(failure), expectedResponses)],
  ['Messages via Chat', () => verifyPhases(routeAnthropicMessagesViaOpenAIChatCompletions(messages, options()), chatEvent(failure), expectedMessages)],
  ['Messages via Responses', () => verifyPhases(routeAnthropicMessagesViaOpenAIResponses(messages, options()), nestedEvent(failure), expectedMessages)],
  ['Gemini via Chat', () => verifyPhases(routeGeminiGenerateContentViaOpenAIChatCompletions(gemini, options()), chatEvent(failure), expectedGemini)],
  ['Gemini via Responses', () => verifyPhases(routeGeminiGenerateContentViaOpenAIResponses(gemini, options()), nestedEvent(failure), expectedGemini)],
  ['Gemini via Messages', () => verifyPhases(routeGeminiGenerateContentViaAnthropicMessages(gemini, { ...options(), fallbackMaxOutputTokens: 16 }), nestedEvent(failure), expectedGemini)],
] as const;

test.each(cases)('%s preserves the error fields in both phases', async (_name, run) => { await run(); });

test.each([
  { message: 'failed' },
  { message: 'failed', code: null, param: null },
  { message: 'failed', type: 'classification' },
  { message: 'failed', type: 'classification', code: null, param: null },
])('OpenAI errors preserve absent and nullable fields independently: %j', async error => {
  const chatTrip = await requireTrip(routeOpenAIChatCompletionsViaOpenAIResponses(chat, options()));
  const responsesTrip = await requireTrip(routeOpenAIResponsesViaOpenAIChatCompletions(responses, options()));
  const encoded = new TextEncoder().encode(JSON.stringify({ error }));
  expect(chatTrip.error(502, new Headers(), encoded)?.body).toEqual({ error });
  const expected = {
    type: 'error', message: error.message,
    ...('code' in error ? { code: error.code } : {}),
    ...('param' in error ? { param: error.param } : {}),
    ...('type' in error ? { provider_specific_fields: { type: error.type } } : {}),
  };
  expect(responsesTrip.error(502, new Headers(), encoded)?.body).toEqual(expected);
  expect(await collect(chatTrip.events(iterate([eventFrame({ type: 'error', error } as const)])))).toEqual([eventFrame({ error })]);
  expect(await collect(responsesTrip.events(iterate([eventFrame(chatEvent(error))])))).toEqual([eventFrame({ ...expected, sequence_number: 0 })]);
});

test('Responses flat errors remove transport discriminants before restatement', async () => {
  const trip = await requireTrip(routeOpenAIChatCompletionsViaOpenAIResponses(chat, options()));
  const error = { type: 'error' as const, sequence_number: 17, message: 'failed', code: null, param: null };
  const frames = await collect(trip.events(iterate([eventFrame(error)])));
  expect(trip.error(502, new Headers(), new TextEncoder().encode(JSON.stringify(error)))?.body).toEqual({
    error: { message: 'failed', code: null, param: null },
  });
  expect(frames).toEqual([eventFrame({ error: { message: 'failed', code: null, param: null } })]);
});

test('native target errors retain canonical object identity', async () => {
  const chatRecords = await collect(irFromOpenAIChatCompletions(iterate([eventFrame(chatEvent(failure))]), {
    roundTrip: createRoundTripReaderCapture<'openaiChatCompletions'>().roundTrip,
  }));
  const messagesRecords = await collect(irFromAnthropicMessages(iterate([eventFrame(nestedEvent(failure))]), {
    roundTrip: createRoundTripReaderCapture<'anthropicMessages'>().roundTrip,
  }));
  const responsesRecords = await collect(irFromOpenAIResponses(iterate([eventFrame(nestedEvent(failure))]), {
    roundTrip: createRoundTripReaderCapture<'openaiResponses'>().roundTrip,
  }));
  for (const records of [chatRecords, messagesRecords, responsesRecords]) {
    const record = records.find(value => value.type === 'error');
    expect(record?.error).toBe(failure);
  }
});

test.each([
  ['Messages', () => routeAnthropicMessagesViaOpenAIResponses(messages, options())],
  ['Gemini', () => routeGeminiGenerateContentViaOpenAIResponses(gemini, options())],
] as const)('%s context overflow keeps the same recognized semantics in both phases', async (protocol, create) => {
  const trip = await create();
  if (trip.type === 'input-error') throw new Error(trip.message);
  const error = { message: 'too long', code: 'context_length_exceeded' };
  const http = trip.error(502, new Headers(), new TextEncoder().encode(JSON.stringify({ error })));
  expect(http?.status).toBe(400);
  const frames: ProtocolFrame<unknown>[] = [];
  for await (const frame of trip.events(iterate([eventFrame({ type: 'error', error } as const)]))) frames.push(frame);
  expect(frames).toEqual([eventFrame(http?.body)]);
  expect(http?.body).toMatchObject(protocol === 'Messages'
    ? { error: { type: 'invalid_request_error', message: PROMPT_TOO_LONG_MESSAGE } }
    : { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'too long' } });
});
