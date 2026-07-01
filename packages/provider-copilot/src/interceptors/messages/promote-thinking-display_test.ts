import { test } from 'vitest';

import { resolveMessagesDownstreamThinkingDisplay, withThinkingDisplayPromoted } from './promote-thinking-display.ts';
import type { MessagesBoundaryCtx } from './types.ts';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { MessagesStreamEvent } from '@floway-dev/protocols/messages';
import type { ExecuteResult } from '@floway-dev/provider';
import { eventResult } from '@floway-dev/provider';
import { assertEquals, stubProviderModel, testTelemetryModelIdentity } from '@floway-dev/test-utils';

const collect = async <T>(events: AsyncIterable<T>): Promise<T[]> => {
  const collected: T[] = [];
  for await (const event of events) collected.push(event);
  return collected;
};

const makeCtx = (
  thinking: MessagesBoundaryCtx['payload']['thinking'],
  overrides: {
    model?: string;
  } = {},
): MessagesBoundaryCtx => ({
  payload: {
    model: overrides.model ?? 'claude-opus-4.7-1m-internal',
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 128,
    ...(thinking ? { thinking } : {}),
  },
  headers: new Headers(),
  model: stubProviderModel({ endpoints: { messages: {} } }),
});

const stubRequest = {};

const okEvents = (): Promise<ExecuteResult<ProtocolFrame<MessagesStreamEvent>>> => Promise.resolve(eventResult((async function* (): AsyncGenerator<ProtocolFrame<MessagesStreamEvent>> {})(), testTelemetryModelIdentity));

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
  const ctx = makeCtx({ type: 'adaptive' });

  const result = await withThinkingDisplayPromoted(ctx, stubRequest, () =>
    Promise.resolve(
      eventResult(
        (async function* (): AsyncGenerator<ProtocolFrame<MessagesStreamEvent>> {
          yield eventFrame<MessagesStreamEvent>({
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'thinking', thinking: 'summary prefix' },
          });
          yield eventFrame<MessagesStreamEvent>({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'thinking_delta', thinking: 'summary body' },
          });
          yield eventFrame<MessagesStreamEvent>({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'signature_delta', signature: 'sig_unchanged' },
          });
          yield eventFrame<MessagesStreamEvent>({
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
    eventFrame<MessagesStreamEvent>({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '' },
    }),
    eventFrame<MessagesStreamEvent>({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'signature_delta', signature: 'sig_unchanged' },
    }),
    eventFrame<MessagesStreamEvent>({
      type: 'content_block_stop',
      index: 0,
    }),
    doneFrame(),
  ]);
});
