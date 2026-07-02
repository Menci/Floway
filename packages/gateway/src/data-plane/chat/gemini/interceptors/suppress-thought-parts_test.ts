import { test } from 'vitest';

import { suppressThoughtParts } from './suppress-thought-parts.ts';
import { createNonResponsesSourceStore } from '../../responses/items/store.ts';
import type { ChatGatewayCtx } from '../../shared/gateway-ctx.ts';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiPayload, GeminiStreamEvent } from '@floway-dev/protocols/gemini';
import { type ExecuteResult, eventResult, type GeminiInvocation } from '@floway-dev/provider';
import { assertEquals, stubModelCandidate, testTelemetryModelIdentity } from '@floway-dev/test-utils';

const stubCtx: ChatGatewayCtx = {
  apiKeyId: 'test-key',
  upstreamIds: null,
  wantsStream: false,
  runtimeLocation: 'TEST',
  currentColo: 'TEST',
  dump: null,
  responseHeaders: new Headers(),
  backgroundScheduler: () => {},
  requestStartedAt: 0,
  store: createNonResponsesSourceStore('test-key'),
};

const invocation = (payload: GeminiPayload): GeminiInvocation => ({
  payload,
  candidate: stubModelCandidate(),
  targetApi: 'messages',
  headers: new Headers(),
});

const streamingResult = (events: GeminiStreamEvent[]) => (): Promise<ExecuteResult<ProtocolFrame<GeminiStreamEvent>>> =>
  Promise.resolve(eventResult(
    (async function* (): AsyncGenerator<ProtocolFrame<GeminiStreamEvent>> {
      for (const event of events) yield eventFrame(event);
    })(),
    testTelemetryModelIdentity,
  ));

const collect = async (events: AsyncIterable<ProtocolFrame<GeminiStreamEvent>>): Promise<GeminiStreamEvent[]> => {
  const out: GeminiStreamEvent[] = [];
  for await (const frame of events) if (frame.type === 'event') out.push(frame.event);
  return out;
};

test('drops thought parts and suppresses candidates that become empty without a finishReason', async () => {
  const upstream: GeminiStreamEvent[] = [
    {
      candidates: [
        {
          index: 0,
          content: {
            role: 'model',
            parts: [
              { thought: true, text: 'reasoning...' },
              { text: 'final answer' },
            ],
          },
        },
      ],
    },
    {
      candidates: [
        {
          index: 0,
          content: { role: 'model', parts: [{ thought: true, text: 'more reasoning' }] },
        },
      ],
    },
  ];

  const res = await suppressThoughtParts(invocation({}), stubCtx, streamingResult(upstream));
  if (res.type !== 'events') throw new Error('expected events');

  assertEquals(await collect(res.events), [
    {
      candidates: [
        {
          index: 0,
          content: { role: 'model', parts: [{ text: 'final answer' }] },
        },
      ],
    },
  ]);
});

test('preserves an empty candidate when it carries a finishReason', async () => {
  const upstream: GeminiStreamEvent[] = [
    {
      candidates: [
        {
          index: 0,
          content: { role: 'model', parts: [{ thought: true, text: 'reasoning...' }] },
          finishReason: 'STOP',
        },
      ],
    },
  ];

  const res = await suppressThoughtParts(invocation({}), stubCtx, streamingResult(upstream));
  if (res.type !== 'events') throw new Error('expected events');

  assertEquals(await collect(res.events), [
    {
      candidates: [
        {
          index: 0,
          content: { role: 'model', parts: [] },
          finishReason: 'STOP',
        },
      ],
    },
  ]);
});

test('passes thought parts through when includeThoughts is opted in', async () => {
  const upstream: GeminiStreamEvent[] = [
    {
      candidates: [
        {
          index: 0,
          content: {
            role: 'model',
            parts: [
              { thought: true, text: 'reasoning...' },
              { text: 'final answer' },
            ],
          },
        },
      ],
    },
  ];

  const res = await suppressThoughtParts(
    invocation({ generationConfig: { thinkingConfig: { includeThoughts: true } } }),
    stubCtx,
    streamingResult(upstream),
  );
  if (res.type !== 'events') throw new Error('expected events');

  assertEquals(await collect(res.events), upstream);
});

test('passes error frames through unchanged', async () => {
  const upstream: GeminiStreamEvent[] = [
    { error: { code: 500, message: 'oops', status: 'INTERNAL' } },
  ];

  const res = await suppressThoughtParts(invocation({}), stubCtx, streamingResult(upstream));
  if (res.type !== 'events') throw new Error('expected events');

  assertEquals(await collect(res.events), upstream);
});

test('preserves usageMetadata-only frames that have no candidates', async () => {
  const upstream: GeminiStreamEvent[] = [
    { usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 5, totalTokenCount: 8 } },
  ];

  const res = await suppressThoughtParts(invocation({}), stubCtx, streamingResult(upstream));
  if (res.type !== 'events') throw new Error('expected events');

  assertEquals(await collect(res.events), upstream);
});
