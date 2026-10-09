import { describe, expect, it } from 'vitest';

import { irSSEToProtocol, protocolSSEToIR } from '../sse.ts';
import { collectIR, parseIRStream } from '../stream.ts';
import { collect } from './helpers.ts';
import type { SseFrame } from '@floway-dev/protocols/common';

const body = (text: string): ReadableStream<Uint8Array> => {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({ start(controller) { for (let index = 0; index < bytes.length; index += 3) controller.enqueue(bytes.slice(index, index + 3)); controller.close(); } });
};
const render = (frames: SseFrame[]): string => frames.map(frame => `${frame.event === undefined ? '' : `event: ${frame.event}\n`}data: ${frame.data}\n\n`).join('');

describe('IR SSE wire adapters', () => {
  it('converts fragmented UTF-8 SSE through the IR wire format', async () => {
    const chunk = (delta: unknown, finish: unknown = null) => ({ id: 's', object: 'chat.completion.chunk', model: 'm', created: 1, choices: [{ index: 0, delta, finish_reason: finish }] });
    const source = `${render([{ type: 'sse', data: JSON.stringify(chunk({ content: 'A😀中B' })) }, { type: 'sse', data: JSON.stringify(chunk({}, 'stop')) }])}data: [DONE]\n\n`;
    const ir = await collect(protocolSSEToIR('openaiChatCompletions', body(source)));
    expect((await collectIR(parseIRStream(body(render(ir))))).choices[0].items[0]).toEqual({ type: 'message', content: [{ type: 'text', text: 'A😀中B' }] });
    const target = await collect(irSSEToProtocol('openaiChatCompletions', body(render(ir)), { id: 't', model: 'm', created: 2 }));
    expect(target.at(-1)?.data).toBe('[DONE]');
    expect(target.some(frame => frame.data.includes('A😀中B'))).toBe(true);
  });

  it('rejects invalid record types and missing operation values at the boundary', async () => {
    for (const record of [{ type: 'unexpected' }, { type: 'operation', operation: 'append', path: ['choices'], value: 1 }, { type: 'operation', operation: 'assign', path: ['choices'] }]) {
      await expect(collect(parseIRStream(body(`data: ${JSON.stringify({ records: [record] })}\n\n`)))).rejects.toThrow();
    }
  });
});
