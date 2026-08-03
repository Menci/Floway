import { Hono } from 'hono';
import { expect, test } from 'vitest';

import { respondChatCompletions } from '../../../../src/data-plane/chat/chat-completions/respond.ts';
import type { DumpAccumulator } from '../../../../src/dump/accumulator.ts';
import { mockChatGatewayCtx } from '../../../test-utils/gateway-ctx.ts';
import type { ChatCompletionsStreamEvent } from '@floway-dev/protocols/chat-completions';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import { eventResult } from '@floway-dev/provider';
import { assert, assertEquals, testTelemetryModelIdentity } from '@floway-dev/test-utils';

const recordingDump = () => {
  const frames: ProtocolFrame<ChatCompletionsStreamEvent>[] = [];
  return {
    frames,
    dump: {
      failed: () => {},
      success: () => {},
      frame: (frame: ProtocolFrame<ChatCompletionsStreamEvent>) => { frames.push(frame); },
    } as unknown as DumpAccumulator,
  };
};

const chunk = (text: string): ChatCompletionsStreamEvent => ({
  id: 'x', object: 'chat.completion.chunk', created: 0, model: 'm',
  choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
});

const serve = async (dump: DumpAccumulator, frames: AsyncGenerator<ProtocolFrame<ChatCompletionsStreamEvent>>): Promise<string> => {
  const ctx = mockChatGatewayCtx({ wantsStream: true, dump });
  const app = new Hono().get('/', c =>
    respondChatCompletions(c, eventResult(frames, testTelemetryModelIdentity), true, true, ctx));
  return await (await app.request('/')).text();
};

test('the error frame the client is sent is recorded like every other frame', async () => {
  const { dump, frames } = recordingDump();
  const body = await serve(dump, (async function* () {
    yield eventFrame(chunk('hi'));
    throw new RangeError('cache token counts exceed inclusive input tokens: 479 - 13312 - 0');
  })());

  // What the client receives is unchanged by this.
  expect(body).toContain('event: error');
  expect(body).toContain('cache token counts exceed inclusive input tokens');
  expect(body).not.toContain('data: [DONE]');

  // And the recorded turn now ends on the same event rather than on the last
  // good chunk.
  assertEquals(frames.length, 2);
  const last = frames[1];
  assert(last.type === 'event', 'expected an event frame');
  const payload = last.event as unknown as { error?: { message?: string } };
  assertEquals(payload.error?.message, 'cache token counts exceed inclusive input tokens: 479 - 13312 - 0');
});

test('a stream that completes records only its own frames', async () => {
  const { dump, frames } = recordingDump();
  const body = await serve(dump, (async function* () {
    yield eventFrame(chunk('hi'));
    yield doneFrame();
  })());

  expect(body).toContain('data: [DONE]');
  assertEquals(frames.length, 2);
});
