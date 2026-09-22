import type { ReplayableBody } from './types.ts';

export const isReplayableBody = (body: unknown): body is ReplayableBody =>
  typeof body === 'object'
  && body !== null
  && typeof (body as Partial<ReplayableBody>).contentLength === 'number'
  && typeof (body as Partial<ReplayableBody>).open === 'function';
