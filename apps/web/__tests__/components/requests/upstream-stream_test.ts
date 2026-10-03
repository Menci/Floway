import { describe, expect, it } from 'vitest';

import { upstreamStreamEvents } from '../../../src/components/requests/upstream-stream';

const SSE = 'event: response.created\ndata: {"type":"response.created","response":{"id":"r","status":"in_progress"}}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"id":"r","status":"completed","usage":{"input_tokens":5,"output_tokens":7,"total_tokens":12}}}\n\ndata: [DONE]\n\n';

describe('upstreamStreamEvents', () => {
  it('parses SSE frames into DumpStreamEvents ending in a done frame', async () => {
    const { events, error } = await upstreamStreamEvents({ encoding: 'utf8', data: SSE }, 'text/event-stream');
    expect(error).toBeNull();
    expect(events).not.toBeNull();
    expect(events!.length).toBe(3);
    expect(events![0]!.frame.type).toBe('event');
    expect(events![2]!.frame.type).toBe('done');
  });

  it('returns null events without an error for non-SSE content types', async () => {
    const { events, error } = await upstreamStreamEvents({ encoding: 'utf8', data: '{"ok":true}' }, 'application/json');
    expect(events).toBeNull();
    expect(error).toBeNull();
  });

  it('tolerates malformed JSON per event without failing the whole stream', async () => {
    const malformed = 'event: response.created\ndata: {"type":"response.created"}\n\nevent: bad\ndata: {broken\n';
    const { events, error } = await upstreamStreamEvents({ encoding: 'utf8', data: malformed }, 'text/event-stream');
    expect(error).toBeNull();
    expect(events).not.toBeNull();
    expect(events!.length).toBe(2);
  });

  it('attaches the SSE event header as type when the JSON body lacks one', async () => {
    const headerOnly = 'event: response.created\ndata: {"response":{"id":"r"}}\n\n';
    const { events } = await upstreamStreamEvents({ encoding: 'utf8', data: headerOnly }, 'text/event-stream');
    expect(events).not.toBeNull();
    const event = events![0]!.frame;
    if (event.type !== 'event') throw new Error('expected event frame');
    expect((event.event as { type: string }).type).toBe('response.created');
  });

  it('decodes base64-encoded SSE bodies before parsing', async () => {
    const base64 = btoa(SSE);
    const { events, error } = await upstreamStreamEvents({ encoding: 'base64', data: base64 }, 'text/event-stream');
    expect(error).toBeNull();
    expect(events).not.toBeNull();
    expect(events!.length).toBe(3);
  });

  it('returns empty events for a stream of only keep-alive comments', async () => {
    const { events, error } = await upstreamStreamEvents({ encoding: 'utf8', data: ':keepalive\n:keepalive\n\n' }, 'text/event-stream');
    expect(error).toBeNull();
    expect(events).toEqual([]);
  });
});
