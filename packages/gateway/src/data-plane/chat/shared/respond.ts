import type { StreamCompletion } from '../../shared/sse.ts';
import { mergeForwardedUpstreamHeaders } from '../../shared/upstream-response.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import { plainResult, readResponseBody } from '@floway-dev/provider';
import type { EventResultMetadata, ExecuteResult, HttpHead, PlainResult } from '@floway-dev/provider';

// Used by count_tokens endpoints that either pass through the upstream body
// or wrap an already-built error/success Response.
export const plainResultFromResponse = async (response: Response, upstream?: string): Promise<PlainResult> => {
  const headers = new Headers(response.headers);
  if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  return plainResult({ status: response.status, headers }, await readResponseBody(response), upstream);
};

export const jsonResponseInit = (http: HttpHead | undefined) => ({
  ...(http === undefined ? {} : { status: http.status }),
  headers: mergeForwardedUpstreamHeaders(undefined, http?.headers),
});

// Per-stream observation accumulated by each source's frame observer and read
// back when the response settles: did the stream fail, did it reach its
// terminal frame, and the last frame-level usage worth billing.
export class SourceStreamState {
  failed = false;
  completed = false;

  failedAfter(completion: StreamCompletion): boolean {
    return completion === 'error' || this.failed || (completion === 'cancel' && !this.completed);
  }
}

export const eventResultMetadata = async <TEvent>(result: Extract<ExecuteResult<ProtocolFrame<TEvent>>, { type: 'events' }>): Promise<EventResultMetadata> =>
  await (result.finalMetadata ?? {
    modelIdentity: result.modelIdentity,
    ...(result.performance ? { performance: result.performance } : {}),
  });
