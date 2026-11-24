import type { FetchInit, ReplayableBody } from './types.ts';

export const isReplayableBody = (body: unknown): body is ReplayableBody =>
  typeof body === 'object'
  && body !== null
  && typeof (body as Partial<ReplayableBody>).contentLength === 'number'
  && typeof (body as Partial<ReplayableBody>).open === 'function';

// Lowers an init onto the runtime `fetch` contract once its body is native.
export const toRequestInit = ({ body: _, signal, ...init }: FetchInit, body: BodyInit | null | undefined): RequestInit => ({
  ...init,
  ...(body === undefined ? {} : { body }),
  ...(signal === undefined ? {} : { signal }),
});
