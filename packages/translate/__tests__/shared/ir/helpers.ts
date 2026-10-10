import type { IR } from '../../../src/shared/ir/ir.ts';
import { consumeIRRecords, type IRFrame } from '../../../src/shared/ir/stream.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';

export const iterate = async function* <T>(values: readonly T[]): AsyncGenerator<T> { yield* values; };
export const collect = async <T>(values: AsyncIterable<T>): Promise<T[]> => { const result: T[] = []; for await (const value of values) result.push(value); return result; };
export const events = async function* <T>(frames: AsyncIterable<ProtocolFrame<T>>): AsyncGenerator<T> { for await (const frame of frames) if (frame.type === 'event') yield frame.event; };
export const completeIR = (value: unknown): IRFrame[] => [{
  records: [
    { type: 'start', id: 'source', model: 'model' },
    { type: 'operation', operation: 'assign', path: ['choices'], value: [{ items: value }] as any },
    { type: 'choice_end', choice: 0, finish_reason: 'stop' },
    { type: 'finish', status: 'completed' },
  ],
}];

export const collectIR = async (frames: AsyncIterable<IRFrame>): Promise<IR> => {
  let state: IR = { choices: [], extensions: {} };
  for await (const value of consumeIRRecords(frames)) {
    state = value.state;
    if (value.record.type === 'error' || value.record.type === 'finish' && value.record.status === 'failed') throw new Error('IR generation failed', { cause: value.record.error });
  }
  return state;
};
