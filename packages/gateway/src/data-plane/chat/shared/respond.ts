import type { GatewayCtx } from '../../shared/gateway-ctx.ts';
import type { SseOutcome } from '../../shared/sse.ts';
import { recordSseOutcome, settle } from '../../shared/telemetry/settle.ts';
import { tokenUsageFromBillableUsage } from '../../shared/telemetry/usage.ts';
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

export type StreamCompletion = 'eof' | 'error' | 'cancel';

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

export const observeChatFrames = async function* <TEvent>(frames: AsyncIterable<ProtocolFrame<TEvent>>, ctx: GatewayCtx): AsyncGenerator<ProtocolFrame<TEvent>> {
  for await (const frame of frames) {
    ctx.dump?.frame(frame);
    yield frame;
  }
};

export const settleChatSse = async <TEvent>(
  ctx: GatewayCtx,
  result: Extract<ExecuteResult<ProtocolFrame<TEvent>>, { type: 'events' }>,
  outcome: SseOutcome,
): Promise<void> => {
  const metadata = await eventResultMetadata(result);
  const usage = tokenUsageFromBillableUsage(metadata.billableUsage);
  const failed = recordSseOutcome(ctx, outcome, metadata.modelIdentity, usage);
  settle(ctx, metadata.performance, metadata.modelIdentity, usage, failed);
};
