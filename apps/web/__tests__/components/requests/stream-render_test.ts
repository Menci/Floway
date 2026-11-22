import { describe, expect, it } from 'vitest';

import { detectCollectKind, extractRawWireBytes, extractWireStreamFrames, renderStreamEvents, streamEventsCopyText, type StreamFrameEntry } from '../../../src/components/requests/stream-render';
import type { ProjectedWireResponse } from '@floway-dev/pipeline/browser';

const event = (frame: StreamFrameEntry['frame'], ts = 1): StreamFrameEntry => ({ frame, ts });

describe('GenerateContent bare errors', () => {
  const error = { error: { code: 500, status: 'INTERNAL', message: 'failure' } };
  it('copies the bare JSON error after normal SSE chunks', () => {
    const chunk = { candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'partial' }] } }] };
    expect(streamEventsCopyText('gemini-generate-content', [event({ type: 'event', event: chunk }), event({ type: 'event', event: error })])).toBe(`data: ${JSON.stringify(chunk)}\n\n${JSON.stringify(error)}`);
  });
});

describe('wire stream extraction', () => {
  const response = (overrides: Partial<ProjectedWireResponse>): ProjectedWireResponse => ({
    headers: [],
    rawFrames: [],
    protocolFrames: [],
    ...overrides,
  });

  it('prefers downstream client protocol frames and otherwise uses protocol frames', () => {
    const client = response({ clientFrames: [{ index: 0, seq: 1, tMs: 15, deltaMs: 2, value: { type: 'event', event: { delta: 'client' } } }] });
    expect(extractWireStreamFrames(client, 'downstream')).toEqual([{ frame: { type: 'event', event: { delta: 'client' } }, ts: 15, deltaMs: 2 }]);
    const protocol = response({ protocolFrames: [{ index: 0, seq: 2, tMs: 20, deltaMs: 3, value: { type: 'done' } }] });
    expect(extractWireStreamFrames(protocol, 'upstream')).toEqual([{ frame: { type: 'done' }, ts: 20, deltaMs: 3 }]);
  });

  it('parses passthrough SSE bytes into inspectable events and concatenates raw bytes', () => {
    const encoder = new TextEncoder();
    const responseWithSse = response({
      headers: [['content-type', 'text/event-stream']],
      rawFrames: [
        { index: 0, seq: 1, tMs: 5, deltaMs: 0, value: encoder.encode('event: delta\ndata: {"text":"hello"}\n\n') },
        { index: 1, seq: 2, tMs: 9, deltaMs: 4, value: encoder.encode('data: [DONE]\n\n') },
      ],
    });
    const frames = extractWireStreamFrames(responseWithSse, 'upstream');
    expect(frames).toHaveLength(2);
    expect(frames[0]?.frame).toEqual({ type: 'event', event: { text: 'hello' } });
    expect(frames[1]?.frame).toEqual({ type: 'done' });
    expect(renderStreamEvents(null, frames)[0]).toMatchObject({ event: 'delta', text: '{\n  "text": "hello"\n}', parseError: null });
    expect(streamEventsCopyText(null, frames)).toBe('event: delta\ndata: {"text":"hello"}\n\ndata: [DONE]\n');
    expect(extractRawWireBytes(responseWithSse)).not.toBeNull();
    expect(new TextDecoder().decode(extractRawWireBytes(responseWithSse)!)).toContain('data: [DONE]');
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
