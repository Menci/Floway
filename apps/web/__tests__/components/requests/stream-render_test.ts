import { describe, expect, it } from 'vitest';

import { detectCollectKind, extractRawWireBytes, extractWireStreamFrames, renderStreamEvents, streamEventsCopyText, type StreamFrameEntry } from '../../../src/components/requests/stream-render';
import type { ProjectedWireResponse } from '@floway-dev/dump/browser';
import { createDumpDecoder, isDecodedStreamRef } from '@floway-dev/dump/browser';
import { Bytes } from '@floway-dev/pipeline/browser';

const event = (frame: StreamFrameEntry['frame'], ts = 1): StreamFrameEntry => ({ frame, ts });

describe('GenerateContent bare errors', () => {
  const error = { error: { code: 500, status: 'INTERNAL', message: 'failure' } };
  it('copies the bare JSON error after normal SSE chunks', () => {
    const chunk = { candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'partial' }] } }] };
    expect(streamEventsCopyText('gemini-generate-content', [event({ type: 'event', event: chunk }), event({ type: 'event', event: error })])).toBe(`data: ${JSON.stringify(chunk)}\n\n${JSON.stringify(error)}`);
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
    expect(frames[0]?.frame).toEqual({ type: 'event', event: { text: 'hello' } });
    expect(frames[1]?.frame).toEqual({ type: 'done' });
    expect(frames.map(({ ts, deltaMs }) => [ts, deltaMs])).toEqual([[7, 0], [9, 2]]);
    expect(renderStreamEvents(null, frames)[0]).toMatchObject({ event: 'delta', text: '{\n  "text": "hello"\n}', parseError: null });
    expect(streamEventsCopyText(null, frames)).toBe('event: delta\ndata: {"text":"hello"}\n\ndata: [DONE]\n');
    expect(extractRawWireBytes(responseWithSse)).not.toBeNull();
    expect(new TextDecoder().decode(extractRawWireBytes(responseWithSse)!)).toContain(': keepalive\n\ndata: [DONE]');
  });

  it('renders generic SSE frames and records per-frame deltas', () => {
    const frames = [event({ type: 'event', event: { hello: 'world' } }, 4), event({ type: 'done' }, 10)];
    expect(renderStreamEvents(null, frames)).toEqual([
      { event: null, text: '{\n  "hello": "world"\n}', parseError: null, timestamp: 4 },
      { event: '[DONE]', text: '[DONE]', parseError: null, timestamp: 10 },
    ]);
  });

  it('detects each supported protocol from its path', () => {
    expect(detectCollectKind('/v1/messages')).toBe('anthropic-messages');
    expect(detectCollectKind('/v1/responses')).toBe('openai-responses');
    expect(detectCollectKind('/v1/chat/completions')).toBe('openai-chat-completions');
    expect(detectCollectKind('/v1/completions')).toBe('openai-completions');
    expect(detectCollectKind('/v1beta/models/gemini:streamGenerateContent?alt=sse')).toBe('gemini-generate-content');
  });
});
