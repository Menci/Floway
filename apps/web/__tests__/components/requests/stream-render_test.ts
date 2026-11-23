import { describe, expect, it } from 'vitest';

import { collectStream, detectCollectKind, extractRawWireBytes, extractWireStreamFrames, renderStreamEvents, streamEventsCopyText, type StreamFrameEntry } from '../../../src/components/requests/stream-render';
import type { ProjectedWireResponse } from '@floway-dev/dump/browser';
import { createDumpDecoder, isDecodedStreamRef } from '@floway-dev/dump/browser';
import { Bytes } from '@floway-dev/pipeline/browser';

const event = (sse: StreamFrameEntry['sse'], ts = 1, deltaMs = 0): StreamFrameEntry => ({ sse, ts, deltaMs });

describe('GenerateContent bare errors', () => {
  const error = { error: { code: 500, status: 'INTERNAL', message: 'failure' } };
  it('copies the bare JSON error after normal SSE chunks', () => {
    const chunk = { candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'partial' }] } }] };
    expect(streamEventsCopyText([event({ type: 'sse', data: JSON.stringify(chunk) }), event({ type: 'sse-raw', data: JSON.stringify(error) })]))
      .toBe(`data: ${JSON.stringify(chunk)}\n\n${JSON.stringify(error)}`);
  });
});

describe('wire stream extraction', () => {
  it('parses passthrough SSE bytes into inspectable events and concatenates raw bytes', () => {
    const body = createDumpDecoder().resolve({ $stream: 1 });
    if (!isDecodedStreamRef(body)) throw new Error('Expected stream reference');
    const responseWithSse: ProjectedWireResponse = {
      status: 200, statusText: '', body, timing: { startedAt: 0, headersAt: 5 },
      headers: [['content-type', 'text/event-stream']],
      stream: {
        streamId: 1, stageId: 2, label: 'wire', createdAtMs: 4, derivedStreamIds: [],
        frames: [
          { index: 0, seq: 1, tMs: 5, deltaMs: 0, value: Bytes.fromUtf8('event: delta\ndata: {"text":') },
          { index: 1, seq: 2, tMs: 7, deltaMs: 2, value: Bytes.fromUtf8('"hello"}\n\n: keepalive\n\n') },
          { index: 2, seq: 3, tMs: 9, deltaMs: 2, value: Bytes.fromUtf8('data: [DONE]\n\n') },
        ],
      },
    };
    const frames = extractWireStreamFrames(responseWithSse);
    expect(frames).toHaveLength(2);
    expect(frames[0]?.sse).toEqual({ type: 'sse', event: 'delta', data: '{"text":"hello"}' });
    expect(frames[1]?.sse).toMatchObject({ type: 'sse', data: '[DONE]' });
    expect(frames.map(({ ts, deltaMs }) => [ts, deltaMs])).toEqual([[7, 0], [9, 2]]);
    expect(renderStreamEvents(frames)[0]).toMatchObject({ event: 'delta', text: '{\n  "text": "hello"\n}', parseError: null });
    expect(streamEventsCopyText(frames)).toBe('event: delta\ndata: {"text":"hello"}\n\ndata: [DONE]\n');
    expect(extractRawWireBytes(responseWithSse)).not.toBeNull();
    expect(new TextDecoder().decode(extractRawWireBytes(responseWithSse)!)).toContain(': keepalive\n\ndata: [DONE]');
  });

  it('renders generic SSE frames and records per-frame deltas', () => {
    const frames = [event({ type: 'sse', data: '{"hello":"world"}' }, 4), event({ type: 'sse', data: '[DONE]' }, 10, 6)];
    expect(renderStreamEvents(frames)).toEqual([
      { event: null, text: '{\n  "hello": "world"\n}', parseError: null, timestamp: 4, deltaMs: 0 },
      { event: '[DONE]', text: '[DONE]', parseError: null, timestamp: 10, deltaMs: 6 },
    ]);
  });

  it('collects an exhausted Gemini stream without a synthetic done frame', async () => {
    const chunk = { candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'hello' }] }, finishReason: 'STOP' }] };
    const completed = await collectStream('gemini-generate-content', [event({ type: 'sse', data: JSON.stringify(chunk) })], true);
    expect(completed).toMatchObject({ result: chunk, truncated: false, error: null });
  });

  it('detects each supported protocol from its path', () => {
    expect(detectCollectKind('/v1/messages')).toBe('anthropic-messages');
    expect(detectCollectKind('/v1/responses')).toBe('openai-responses');
    expect(detectCollectKind('/v1/chat/completions')).toBe('openai-chat-completions');
    expect(detectCollectKind('/v1/completions')).toBe('openai-completions');
    expect(detectCollectKind('/v1beta/models/gemini:streamGenerateContent?alt=sse')).toBe('gemini-generate-content');
  });
});
