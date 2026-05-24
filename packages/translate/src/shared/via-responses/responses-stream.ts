import type { ResponseStreamEvent } from '@floway-dev/protocols/responses';

export type ResponseEvent<TType extends ResponseStreamEvent['type']> = Extract<ResponseStreamEvent, { type: TType }>;

export const responsePartKey = (outputIndex: number, partIndex: number): string => `${outputIndex}:${partIndex}`;
