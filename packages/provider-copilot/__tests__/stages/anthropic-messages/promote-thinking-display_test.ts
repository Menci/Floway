import { test } from 'vitest';

import { resolveAnthropicMessagesDownstreamThinkingDisplay, copilotAnthropicMessagesThinkingDisplay } from '../../../src/stages/anthropic-messages/promote-thinking-display.ts';
import type { AnthropicMessagesStreamEvent } from '@floway-dev/protocols/anthropic-messages';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { ExecuteResult } from '@floway-dev/provider';
import { eventResult } from '@floway-dev/provider';
import { applyProviderStage, type AnthropicMessagesProbe } from '@floway-dev/test-utils';
import { assertEquals, stubProviderModel, testTelemetryModelIdentity } from '@floway-dev/test-utils';

const collect = async <T>(events: AsyncIterable<T>): Promise<T[]> => {
  const collected: T[] = [];
  for await (const event of events) collected.push(event);
  return collected;
};

const makeCtx = (
  thinking: AnthropicMessagesProbe['payload']['thinking'],
  overrides: {
    model?: string;
  } = {},
): AnthropicMessagesProbe => ({
  payload: {
    model: overrides.model ?? 'claude-opus-4.7-1m-internal',
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 128,
    ...(thinking ? { thinking } : {}),
  },
  headers: new Headers(),
  anthropicBeta: [],
  model: stubProviderModel({ endpoints: { anthropicMessages: {} } }),
});

const okEvents = (): Promise<ExecuteResult<ProtocolFrame<AnthropicMessagesStreamEvent>>> => Promise.resolve(eventResult((async function* (): AsyncGenerator<ProtocolFrame<AnthropicMessagesStreamEvent>> {})(), testTelemetryModelIdentity));

test('resolveAnthropicMessagesDownstreamThinkingDisplay exposes 4.7+ omitted by default and older Claude as summarized', () => {
  assertEquals(resolveAnthropicMessagesDownstreamThinkingDisplay(makeCtx({ type: 'adaptive' })), 'omitted');
  assertEquals(
    resolveAnthropicMessagesDownstreamThinkingDisplay({
      ...makeCtx({ type: 'adaptive' }),
      payload: {
        ...makeCtx({ type: 'adaptive' }).payload,
        model: 'claude-opus-4-7-20260219',
      },
    }),
    'omitted',
  );
  assertEquals(
    resolveAnthropicMessagesDownstreamThinkingDisplay({
      ...makeCtx({ type: 'adaptive' }),
      payload: {
        ...makeCtx({ type: 'adaptive' }).payload,
        model: 'claude-opus-4.6',
      },
    }),
    'summarized',
  );
  assertEquals(
    resolveAnthropicMessagesDownstreamThinkingDisplay({
      ...makeCtx({ type: 'adaptive' }),
      payload: {
        ...makeCtx({ type: 'adaptive' }).payload,
        model: 'gpt-5.2',
      },
    }),
    'summarized',
  );
});

test('resolveAnthropicMessagesDownstreamThinkingDisplay preserves explicit display', () => {
  assertEquals(resolveAnthropicMessagesDownstreamThinkingDisplay(makeCtx({ type: 'adaptive', display: 'summarized' })), 'summarized');
  assertEquals(resolveAnthropicMessagesDownstreamThinkingDisplay(makeCtx({ type: 'adaptive', display: 'omitted' })), 'omitted');
  assertEquals(resolveAnthropicMessagesDownstreamThinkingDisplay(makeCtx({ type: 'adaptive', display: 'full' })), 'full');
});

test('resolveAnthropicMessagesDownstreamThinkingDisplay ignores unknown explicit display values', () => {
  const ctx = makeCtx({ type: 'adaptive' });
  (ctx.payload.thinking as { display?: unknown }).display = 'omit';

  assertEquals(resolveAnthropicMessagesDownstreamThinkingDisplay(ctx), undefined);
});

test('copilotAnthropicMessagesThinkingDisplay sends summarized upstream when thinking display is omitted', async () => {
  const ctx = makeCtx({ type: 'adaptive' });

  await applyProviderStage(copilotAnthropicMessagesThinkingDisplay, ctx, () =>
    Promise.resolve({
      type: 'internal-error',
      status: 418,
      error: {
        type: 'internal_error',
        name: 'Error',
        message: 'stop',
        stack: '',
        target_api: 'anthropicMessages',
      },
    }));

  assertEquals(ctx.payload.thinking?.display, 'summarized');
});

test('copilotAnthropicMessagesThinkingDisplay overrides omitted but preserves full', async () => {
  const omittedCtx = makeCtx({ type: 'adaptive', display: 'omitted' });
  const fullCtx = makeCtx({ type: 'adaptive', display: 'full' });

  await applyProviderStage(copilotAnthropicMessagesThinkingDisplay, omittedCtx, okEvents);
  await applyProviderStage(copilotAnthropicMessagesThinkingDisplay, fullCtx, okEvents);

  assertEquals(omittedCtx.payload.thinking?.display, 'summarized');
  assertEquals(fullCtx.payload.thinking?.display, 'full');
});

test('copilotAnthropicMessagesThinkingDisplay leaves disabled or absent thinking untouched', async () => {
  const disabledCtx = makeCtx({ type: 'disabled' });
  const absentCtx = makeCtx(undefined);

  await applyProviderStage(copilotAnthropicMessagesThinkingDisplay, disabledCtx, okEvents);
  await applyProviderStage(copilotAnthropicMessagesThinkingDisplay, absentCtx, okEvents);

  assertEquals(disabledCtx.payload.thinking, { type: 'disabled' });
  assertEquals(absentCtx.payload.thinking, undefined);
});

test('copilotAnthropicMessagesThinkingDisplay leaves unknown display values for upstream validation', async () => {
  const ctx = makeCtx({ type: 'adaptive' });
  (ctx.payload.thinking as { display?: unknown }).display = 'omit';

  await applyProviderStage(copilotAnthropicMessagesThinkingDisplay, ctx, okEvents);

  assertEquals((ctx.payload.thinking as { display?: unknown }).display, 'omit');
});

test('copilotAnthropicMessagesThinkingDisplay simulates omitted display on protocol events', async () => {
  const ctx = makeCtx({ type: 'adaptive' });

  const result = await applyProviderStage(copilotAnthropicMessagesThinkingDisplay, ctx, () =>
    Promise.resolve(
      eventResult(
        (async function* (): AsyncGenerator<ProtocolFrame<AnthropicMessagesStreamEvent>> {
          yield eventFrame<AnthropicMessagesStreamEvent>({
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'thinking', thinking: 'summary prefix' },
          });
          yield eventFrame<AnthropicMessagesStreamEvent>({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'thinking_delta', thinking: 'summary body' },
          });
          yield eventFrame<AnthropicMessagesStreamEvent>({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'signature_delta', signature: 'sig_unchanged' },
          });
          yield eventFrame<AnthropicMessagesStreamEvent>({
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
    eventFrame<AnthropicMessagesStreamEvent>({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '' },
    }),
    eventFrame<AnthropicMessagesStreamEvent>({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'signature_delta', signature: 'sig_unchanged' },
    }),
    eventFrame<AnthropicMessagesStreamEvent>({
      type: 'content_block_stop',
      index: 0,
    }),
    doneFrame(),
  ]);
});
