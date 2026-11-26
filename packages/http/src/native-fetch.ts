import { isCausedBy } from './abort.ts';
import { HttpTransportError } from './errors.ts';
import type { trackReadableFailure } from './readable.ts';
import type { FetchResponse } from './types.ts';

interface NativeFetchErrors {
  upload?: ReturnType<typeof trackReadableFailure> | undefined;
  isFetchTransportFailure: (cause: unknown) => boolean;
  classifyBodyFailure?: NonNullable<FetchResponse['classifyBodyFailure']>;
  restoreAbort?: (cause: unknown, signal: AbortSignal | null | undefined) => Error | undefined;
}

export const fetchWithTransportErrors = async (
  request: Request | string,
  init: RequestInit | undefined,
  { upload, isFetchTransportFailure, classifyBodyFailure, restoreAbort }: NativeFetchErrors,
): Promise<FetchResponse> => {
  const requestUrl = typeof request === 'string' ? request : request.url;
  const { protocol } = new URL(requestUrl);
  if (protocol !== 'https:' && protocol !== 'http:') throw new TypeError(`Unsupported upstream fetch protocol: ${protocol}`);
  const signal = init?.signal === undefined && typeof request !== 'string' ? request.signal : init?.signal;
  const response = await fetch(request, init).catch((cause: unknown) => {
    const failure = upload?.failure;
    if (failure !== undefined && (cause === failure.cause || isCausedBy(cause, failure.cause))) throw failure.cause;
    const abort = restoreAbort?.(cause, signal);
    if (abort !== undefined) throw abort;
    if (isCausedBy(cause, signal?.reason) || !isFetchTransportFailure(cause)) throw cause;
    throw new HttpTransportError(cause);
  });
  if (classifyBodyFailure === undefined && restoreAbort === undefined) return response;
  return Object.assign(response, {
    classifyBodyFailure(cause: unknown) {
      const failure = upload?.failure;
      if (failure !== undefined && (cause === failure.cause || isCausedBy(cause, failure.cause))) return undefined;
      const abort = restoreAbort?.(cause, signal);
      return abort === undefined ? classifyBodyFailure?.(cause) : { kind: 'abort' as const, cause: abort };
    },
  });
};
