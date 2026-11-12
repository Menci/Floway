import type { ProtocolFrame } from '@floway-dev/protocols/common';

export const iterate = async function* <T>(values: readonly T[]): AsyncGenerator<T> { yield* values; };
export const collect = async <T>(values: AsyncIterable<T>): Promise<T[]> => { const result: T[] = []; for await (const value of values) result.push(value); return result; };
export const events = async function* <T>(frames: AsyncIterable<ProtocolFrame<T>>): AsyncGenerator<T> { for await (const frame of frames) if (frame.type === 'event') yield frame.event; };
