import { expect, test } from 'vitest';

import type { ChatOperation } from '../../../../src/data-plane/chat/shared/pipeline.ts';
import { createSidecarCodecFactory, SidecarDomain } from '../../../../src/data-plane/chat/shared/sidecar-codec.ts';
import { translateChatFrames } from '../../../../src/data-plane/chat/shared/translate.ts';
import type { GatewayServices } from '../../../../src/data-plane/pipeline/services.ts';
import { factSpace, run, type ManagedStream, type Result } from '@floway-dev/pipeline';
import { decodeAnthropicMessagesStream } from '@floway-dev/protocols/anthropic-messages';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import { decodeOpenAIChatCompletionsStream } from '@floway-dev/protocols/openai-chat-completions';
import { decodeOpenAIResponsesStream } from '@floway-dev/protocols/openai-responses';
import type { ProtocolStreamError } from '@floway-dev/provider';
import { routeAnthropicMessagesViaOpenAIChatCompletions, routeAnthropicMessagesViaOpenAIResponses, routeOpenAIResponsesViaAnthropicMessages } from '@floway-dev/translate';

const options = { sidecarCodec: createSidecarCodecFactory('test-translation').codecFor(SidecarDomain.TranslatedAssistantTurn) };
const sseBody = async function* (event: unknown, name?: string): AsyncGenerator<Result<Uint8Array, never>> {
  const field = name === undefined ? '' : `event: ${name}\n`;
  yield { ok: true, value: new TextEncoder().encode(`${field}data: ${JSON.stringify(event)}\n\n`) };
};

const translate = async <Target, Source>(
  sourceProtocol: ChatOperation,
  targetProtocol: ChatOperation,
  transform: (frames: AsyncIterable<ProtocolFrame<Target> | { ok: false; error: unknown; event?: Target }>) => AsyncIterable<ProtocolFrame<Source>>,
  source: () => AsyncGenerator<Result<Target, ProtocolStreamError>>,
): Promise<Result<Source, ProtocolStreamError>[]> => {
  const { compose, defineStage } = factSpace<{
    'response.target': ManagedStream<Target, ProtocolStreamError>;
    'response.source': ManagedStream<Source, ProtocolStreamError>;
  }, GatewayServices>();
  const pipeline = compose('translation fixture', {
    entry: [],
    exit: ['response.source'],
    stages: [defineStage({
      name: 'translate returned frames',
      through: {
        request: { needs: [], provides: [], consumes: [] },
        response: { needs: ['response.target'], provides: ['response.source'], consumes: ['response.target'] },
      },
      async execute(facts, scope) {
        const { 'response.target': target, ...answer } = await scope.next(facts);
        return { ...answer, 'response.source': translateChatFrames({ source: sourceProtocol, target: targetProtocol }, target, scope, transform) };
      },
    })],
    ending: defineStage({
      name: 'translation source fixture',
      request: { needs: [] },
      return: { provides: ['response.target'] },
      async execute(_facts, scope) {
        return { 'response.target': scope.createStream(source) };
      },
    }),
  });
  const running = run(pipeline, {}, { services: {} as GatewayServices, signal: new AbortController().signal, waitUntil() {} });
  void running.done.catch(() => undefined);
  const answer = await running.result;
  const output = await Array.fromAsync(running.read(answer['response.source']));
  await running.done;
  return output;
};

test.each(['named', 'typed'] as const)('translates a native Anthropic %s error into one source-dialect Err and drains its source', async mode => {
  const trip = await routeOpenAIResponsesViaAnthropicMessages({ model: 'test', input: [], stream: true }, { ...options, fallbackMaxOutputTokens: 32 });
  if (trip.type !== 'trip') throw new Error(trip.message);
  const message = 'upstream overloaded';
  const drained = Promise.withResolvers<void>();

  const output = await translate('openaiResponses', 'anthropicMessages', trip.events, async function* () {
    const body = mode === 'named' ? sseBody({ error: { type: 'overloaded_error', message } }, 'error') : sseBody({ type: 'error', message });
    yield* decodeAnthropicMessagesStream(body);
    drained.resolve();
  });

  expect(output).toMatchObject([{ ok: false, error: { kind: 'protocol', cause: expect.any(Error), event: { notification: { type: 'error', message } } } }]);
  await drained.promise;
});

test('forwards a transport failure as the original Err without making up a provider event', async () => {
  const trip = await routeOpenAIResponsesViaAnthropicMessages({ model: 'test', input: [], stream: true }, { ...options, fallbackMaxOutputTokens: 32 });
  if (trip.type !== 'trip') throw new Error(trip.message);
  const failure = { kind: 'transport' as const, cause: new Error('socket dropped') };
  const output = await translate('openaiResponses', 'anthropicMessages', trip.events, async function* () { yield { ok: false, error: failure }; });
  expect(output).toEqual([{ ok: false, error: failure }]);
});

test.each(['bio_policy', 'cyber_policy'])('renders a %s Responses failure as the client dialect content-filter finish', async code => {
  const trip = await routeAnthropicMessagesViaOpenAIResponses({ model: 'test', messages: [{ role: 'user', content: 'hello' }], max_tokens: 32, stream: true }, options);
  if (trip.type !== 'trip') throw new Error(trip.message);
  const body = async function* () {
    yield* sseBody({ type: 'error', code, message: 'Classifier declined.' });
    yield* sseBody({
      type: 'response.failed',
      response: { id: 'resp_policy', model: 'served', output: [], status: 'failed', error: { code, message: 'Classifier declined.' } },
    });
  };
  const output = await translate('anthropicMessages', 'openaiResponses', trip.events, () => decodeOpenAIResponsesStream(body()));

  expect(output).toContainEqual({ ok: true, value: expect.objectContaining({ type: 'message_stop' }) });
  expect(output).toContainEqual({ ok: true, value: expect.objectContaining({ type: 'message_delta', delta: expect.objectContaining({ stop_reason: 'refusal' }) }) });
  expect(output.every(frame => frame.ok)).toBe(true);
});

test('translates a grouped native Responses failure into one client error event', async () => {
  const trip = await routeAnthropicMessagesViaOpenAIResponses({ model: 'test', messages: [{ role: 'user', content: 'hello' }], max_tokens: 32, stream: true }, options);
  if (trip.type !== 'trip') throw new Error(trip.message);
  const message = 'upstream model server failed';
  const output = await translate('anthropicMessages', 'openaiResponses', trip.events, () => decodeOpenAIResponsesStream(sseBody({ type: 'error', message, code: 'server_error' })));
  expect(output).toMatchObject([{ ok: false, error: { kind: 'protocol', event: { type: 'error', error: { message } } } }]);
});

test('translates a flattened native Chat Completions error into one client error event', async () => {
  const trip = await routeAnthropicMessagesViaOpenAIChatCompletions({ model: 'test', messages: [{ role: 'user', content: 'hello' }], max_tokens: 32, stream: true }, options);
  if (trip.type !== 'trip') throw new Error(trip.message);
  const message = 'upstream model server failed';
  const output = await translate('anthropicMessages', 'openaiChatCompletions', trip.events, () => decodeOpenAIChatCompletionsStream(sseBody({ message, type: 'server_error' }, 'error')));
  expect(output).toMatchObject([{ ok: false, error: { kind: 'protocol', event: { type: 'error', error: { message } } } }]);
});

test('requires a translated error event for a non-policy upstream failure', async () => {
  const running = translate('openaiChatCompletions', 'anthropicMessages', async function* (frames) {
    for await (const frame of frames) {
      if ('ok' in frame) yield eventFrame({ choices: [] });
    }
  }, () => decodeAnthropicMessagesStream(sseBody({ type: 'error', error: { message: 'ordinary failure' } })));
  await expect(running).rejects.toThrow('An upstream protocol error must translate to a source error event');
});

test('lets a translator publish its outcome while a discarded source still produces', async () => {
  const release = Promise.withResolvers<void>();
  const drained = Promise.withResolvers<void>();
  const running = translate<string, string>('openaiResponses', 'openaiChatCompletions', async function* (frames) {
    for await (const frame of frames) {
      if ('type' in frame && frame.type === 'event') {
        yield eventFrame(frame.event.toUpperCase());
        return;
      }
    }
  }, async function* () {
    yield { ok: true, value: 'ready' };
    await release.promise;
    yield { ok: true, value: 'discarded' };
    drained.resolve();
  });
  try {
    await expect(running).resolves.toEqual([{ ok: true, value: 'READY' }]);
  } finally {
    release.resolve();
  }
  await drained.promise;
});
