import { test } from 'vitest';

import { resolveMessagesDownstreamThinkingDisplay, withThinkingDisplayPromoted } from './promote-thinking-display.ts';
import { assertEquals } from '../../../../../test-assert.ts';
import { stubProvider, stubUpstreamModel, testTelemetryModelIdentity } from '../../../../../test-helpers.ts';
import type { MessagesInvocation, RequestContext } from '../../../../llm/interceptors.ts';
import { eventResult, type ExecuteResult } from '../../../../llm/shared/errors/result.ts';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { MessagesStreamEventData } from '@floway-dev/protocols/messages';

const collect = async <T>(events: AsyncIterable<T>): Promise<T[]> => {
  const collected: T[] = [];
  for await (const event of events) collected.push(event);
  return collected;
};

const makeCtx = (
  thinking: MessagesInvocation['payload']['thinking'],
  overrides: {
    model?: string;
    sourceApi?: MessagesInvocation['sourceApi'];
  } = {},
): MessagesInvocation => ({
  sourceApi: overrides.sourceApi ?? 'messages',
  targetApi: 'messages',
  model: overrides.model ?? 'claude-opus-4.7-1m-internal',
  upstream: 'test-upstream',
  payload: {
    model: overrides.model ?? 'claude-opus-4.7-1m-internal',
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 128,
    ...(thinking ? { thinking } : {}),
  },
  provider: stubProvider(),
  upstreamModel: stubUpstreamModel({ upstreamEndpoints: ['messages'] }),
  enabledFlags: new Set<string>(),
  headers: {},
});

const stubRequest: RequestContext = {
  requestStartedAt: 0,
  runtimeLocation: 'test',
  clientStream: false,
};

const okEvents = (): Promise<ExecuteResult<ProtocolFrame<MessagesStreamEventData>>> => Promise.resolve(eventResult((async function* (): AsyncGenerator<ProtocolFrame<MessagesStreamEventData>> {})(), testTelemetryModelIdentity));

test('resolveMessagesDownstreamThinkingDisplay exposes 4.7+ omitted by default and older Claude as summarized', () => {
  assertEquals(resolveMessagesDownstreamThinkingDisplay(makeCtx({ type: 'adaptive' })), 'omitted');
  assertEquals(
    resolveMessagesDownstreamThinkingDisplay({
      ...makeCtx({ type: 'adaptive' }),
      payload: {
        ...makeCtx({ type: 'adaptive' }).payload,
        model: 'claude-opus-4-7-20260219',
      },
    }),
    'omitted',
  );
  assertEquals(
    resolveMessagesDownstreamThinkingDisplay({
      ...makeCtx({ type: 'adaptive' }),
      payload: {
        ...makeCtx({ type: 'adaptive' }).payload,
        model: 'claude-opus-4.6',
      },
    }),
    'summarized',
  );
  assertEquals(
    resolveMessagesDownstreamThinkingDisplay({
      ...makeCtx({ type: 'adaptive' }),
      payload: {
        ...makeCtx({ type: 'adaptive' }).payload,
        model: 'gpt-5.2',
      },
    }),
    'summarized',
  );
});

test('resolveMessagesDownstreamThinkingDisplay preserves explicit display', () => {
  assertEquals(resolveMessagesDownstreamThinkingDisplay(makeCtx({ type: 'adaptive', display: 'summarized' })), 'summarized');
  assertEquals(resolveMessagesDownstreamThinkingDisplay(makeCtx({ type: 'adaptive', display: 'omitted' })), 'omitted');
  assertEquals(resolveMessagesDownstreamThinkingDisplay(makeCtx({ type: 'adaptive', display: 'full' })), 'full');
});

test('resolveMessagesDownstreamThinkingDisplay ignores unknown explicit display values', () => {
  const ctx = makeCtx({ type: 'adaptive' });
  (ctx.payload.thinking as { display?: unknown }).display = 'omit';

  assertEquals(resolveMessagesDownstreamThinkingDisplay(ctx), undefined);
});

test('withThinkingDisplayPromoted sends summarized upstream when thinking display is omitted', async () => {
  const ctx = makeCtx({ type: 'adaptive' });

  await withThinkingDisplayPromoted(ctx, stubRequest, () =>
    Promise.resolve({
      type: 'internal-error',
      status: 418,
      error: {
        type: 'internal_error',
        name: 'Error',
        message: 'stop',
        stack: '',
        source_api: 'messages',
        target_api: 'messages',
      },
    }));

  assertEquals(ctx.payload.thinking?.display, 'summarized');
});

test('withThinkingDisplayPromoted overrides omitted but preserves full', async () => {
  const omittedCtx = makeCtx({ type: 'adaptive', display: 'omitted' });
  const fullCtx = makeCtx({ type: 'adaptive', display: 'full' });

  await withThinkingDisplayPromoted(omittedCtx, stubRequest, okEvents);
  await withThinkingDisplayPromoted(fullCtx, stubRequest, okEvents);

  assertEquals(omittedCtx.payload.thinking?.display, 'summarized');
  assertEquals(fullCtx.payload.thinking?.display, 'full');
});

test('withThinkingDisplayPromoted leaves disabled or absent thinking untouched', async () => {
  const disabledCtx = makeCtx({ type: 'disabled' });
  const absentCtx = makeCtx(undefined);

  await withThinkingDisplayPromoted(disabledCtx, stubRequest, okEvents);
  await withThinkingDisplayPromoted(absentCtx, stubRequest, okEvents);

  assertEquals(disabledCtx.payload.thinking, { type: 'disabled' });
  assertEquals(absentCtx.payload.thinking, undefined);
});

test('withThinkingDisplayPromoted leaves unknown display values for upstream validation', async () => {
  const ctx = makeCtx({ type: 'adaptive' });
  (ctx.payload.thinking as { display?: unknown }).display = 'omit';

  await withThinkingDisplayPromoted(ctx, stubRequest, okEvents);

  assertEquals((ctx.payload.thinking as { display?: unknown }).display, 'omit');
});

test('withThinkingDisplayPromoted simulates omitted display on protocol events', async () => {
  const ctx = makeCtx({ type: 'adaptive' }, { sourceApi: 'responses' });

  const result = await withThinkingDisplayPromoted(ctx, stubRequest, () =>
    Promise.resolve(
      eventResult(
        (async function* (): AsyncGenerator<ProtocolFrame<MessagesStreamEventData>> {
          yield eventFrame<MessagesStreamEventData>({
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'thinking', thinking: 'summary prefix' },
          });
          yield eventFrame<MessagesStreamEventData>({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'thinking_delta', thinking: 'summary body' },
          });
          yield eventFrame<MessagesStreamEventData>({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'signature_delta', signature: 'sig_unchanged' },
          });
          yield eventFrame<MessagesStreamEventData>({
            type: 'content_block_stop',
            index: 0,
          });
          yield doneFrame();
        })(),
        testTelemetryModelIdentity,
      ),
    ));

  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('expected events');

  assertEquals(await collect(result.events), [
    eventFrame<MessagesStreamEventData>({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '' },
    }),
    eventFrame<MessagesStreamEventData>({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'signature_delta', signature: 'sig_unchanged' },
    }),
    eventFrame<MessagesStreamEventData>({
      type: 'content_block_stop',
      index: 0,
    }),
    doneFrame(),
  ]);
});
