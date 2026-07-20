import type { StreamCompletion } from './stream/sse.ts';
import type { TokenUsage } from '../../../repo/types.ts';
import { hasTokenUsage } from '../../shared/telemetry/usage.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import { plainResult } from '@floway-dev/provider';
import type { EventResultMetadata, ExecuteResult, PlainResult } from '@floway-dev/provider';

// Emits a measurement endpoint's already-shaped body verbatim. The endpoint's
// `attempt` owns all shaping — the success body and any source-specific error
// envelope — so every source's `respond` renders a plain result identically.
export const plainResultToResponse = (result: PlainResult): Response =>
  new Response(result.body.slice().buffer, { status: result.status, headers: result.headers });

// Used by count_tokens endpoints that either pass through the upstream body
// or wrap an already-built error/success Response.
export const plainResultFromResponse = async (response: Response, upstream?: string): Promise<PlainResult> =>
  plainResult(
    response.status,
    new Headers({ 'content-type': response.headers.get('content-type') ?? 'application/json' }),
    new Uint8Array(await response.arrayBuffer()),
    upstream,
  );

// Per-stream observation accumulated by each source's frame observer and read
// back when the response settles: did the stream fail, did it reach its
// terminal frame, and the last frame-level usage worth billing.
export class SourceStreamState {
  failed = false;
  completed = false;
  usage: TokenUsage | null = null;

  // Only a frame carrying real (non-zero) usage overwrites the running figure,
  // so an empty trailing frame can't wipe a good count.
  rememberUsage(usage: TokenUsage | null): void {
    if (usage && hasTokenUsage(usage)) this.usage = usage;
  }

  failedAfter(completion: StreamCompletion): boolean {
    return completion === 'error' || this.failed || (completion === 'cancel' && !this.completed);
  }
}

export const eventResultMetadata = async <TEvent>(result: Extract<ExecuteResult<ProtocolFrame<TEvent>>, { type: 'events' }>): Promise<EventResultMetadata> =>
  await (result.finalMetadata ?? {
    modelIdentity: result.modelIdentity,
    ...(result.performance ? { performance: result.performance } : {}),
  });
