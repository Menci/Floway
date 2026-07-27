import { test } from 'vitest';

import { streamingProviderCall } from '../src/streaming.ts';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import { assertEquals, assertRejects, assertStringIncludes } from '@floway-dev/test-utils';

interface StubEvent { type: string }

// Stub parser: feed the body bytes through TextDecoder and yield one
// eventFrame per non-empty line, plus a terminal doneFrame. Mirrors the
// shape (but not the protocol-specific logic) of parseXxxStream so we can
// assert streamingProviderCall plumbing without dragging in protocol parsers.
const stubParser = (body: ReadableStream<Uint8Array>): AsyncIterable<ProtocolFrame<StubEvent>> => (async function* () {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      buffer += decoder.decode();
      break;
    }
    buffer += decoder.decode(value, { stream: true });
  }
  for (const line of buffer.split('\n').filter(Boolean)) {
    yield eventFrame<StubEvent>({ type: line });
  }
  yield doneFrame();
})();

test('streamingProviderCall returns ok:false when upstream is non-2xx', async () => {
  const response = new Response('rate limited', { status: 429 });
  const result = await streamingProviderCall(Promise.resolve(response), stubParser, 'm-1', undefined);
  assertEquals(result.ok, false);
  if (result.ok) throw new Error('expected ok:false');
  assertEquals(result.response.status, 429);
  assertEquals(result.modelKey, 'm-1');
});

test('streamingProviderCall throws on 2xx without a body, surfacing the status and an <empty> body marker', async () => {
  // 204 is the canonical "no body" success; this is a provider-contract violation
  // because the streaming endpoints always force stream:true.
  const response = new Response(null, { status: 204 });
  await assertRejects(async () => {
    try {
      await streamingProviderCall(Promise.resolve(response), stubParser, 'm-1', undefined);
    } catch (error) {
      assertStringIncludes((error as Error).message, '204');
      assertStringIncludes((error as Error).message, 'stream is required');
      assertStringIncludes((error as Error).message, 'Body: <empty>');
      throw error;
    }
  }, Error);
});

test('streamingProviderCall throws when 2xx content-type is not text/event-stream, including the upstream body for diagnosis', async () => {
  const response = new Response(JSON.stringify({ error: { message: 'azure stub' } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  await assertRejects(async () => {
    try {
      await streamingProviderCall(Promise.resolve(response), stubParser, 'm-1', undefined);
    } catch (error) {
      assertStringIncludes((error as Error).message, '200');
      assertStringIncludes((error as Error).message, 'application/json');
      assertStringIncludes((error as Error).message, 'stream is required');
      assertStringIncludes((error as Error).message, 'azure stub');
      throw error;
    }
  }, Error);
});

test('streamingProviderCall surfaces "unknown" content-type when the header is missing', async () => {
  // Cloudflare Workers sometimes hands us a 200 with no content-type header
  // when the upstream response is malformed; the diagnostic must label that
  // as "unknown" rather than the empty string so the operator can grep for it.
  const response = new Response('{"choices":[]}', { status: 200 });
  await assertRejects(async () => {
    try {
      await streamingProviderCall(Promise.resolve(response), stubParser, 'm-1', undefined);
    } catch (error) {
      assertStringIncludes((error as Error).message, '"unknown"');
      assertStringIncludes((error as Error).message, '{"choices":[]}');
      throw error;
    }
  }, Error);
});

test('streamingProviderCall truncates oversized bodies in the error message', async () => {
  const big = 'x'.repeat(2048);
  const response = new Response(big, { status: 200, headers: { 'content-type': 'application/json' } });
  await assertRejects(async () => {
    try {
      await streamingProviderCall(Promise.resolve(response), stubParser, 'm-1', undefined);
    } catch (error) {
      assertStringIncludes((error as Error).message, '...[truncated]');
      throw error;
    }
  }, Error);
});

test('streamingProviderCall returns ok:true with parsed frames on 2xx SSE', async () => {
  const response = new Response('alpha\nbeta\n', {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8' },
  });
  const result = await streamingProviderCall(Promise.resolve(response), stubParser, 'm-1', undefined);
  assertEquals(result.ok, true);
  if (!result.ok) throw new Error('expected ok:true');
  const frames: ProtocolFrame<StubEvent>[] = [];
  for await (const frame of result.events) frames.push(frame);
  assertEquals(frames, [eventFrame({ type: 'alpha' }), eventFrame({ type: 'beta' }), doneFrame()]);
});
