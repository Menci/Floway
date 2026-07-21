import { recordPerformance, type PerformanceTelemetryContext } from './performance.ts';
import { recordTokenUsage } from './usage.ts';
import type { TokenUsage } from '../../../repo/types.ts';
import type { GatewayCtx } from '../../chat/shared/gateway-ctx.ts';
import type { TelemetryModelIdentity } from '@floway-dev/provider';

// Terminal settle for a successful upstream call (or a partial-output
// failure where tokens were metered): schedule the usage row and record
// the perf sample as an atomic pair. Passing `requestFinishedAt` lets
// the caller sample the stream-end monotonic timestamp at exactly the
// moment the token stream terminates, so TPOT measures the stream
// itself rather than the settle path. Callers with no such distinction
// (passthrough JSON, the image-generation server tool) omit it and get
// the call-time stamp.
//
// The usage-record D1 write is fire-and-forget. A transient repo failure
// must not surface as a 502 for a request whose upstream response is
// already in flight (or already sent). The runtime's backgroundScheduler
// binds the promise to the request's lifetime — Cloudflare Workers'
// waitUntil binds it to the fetch handler (or, for the WS transport, to
// a session-scoped waitUntil opened on 101), and Node keeps the process
// event loop alive. Every settled request increments its request bucket;
// detailed metric rows are present only when the upstream meters them.
export const settle = (
  ctx: GatewayCtx,
  telemetry: PerformanceTelemetryContext | undefined,
  identity: TelemetryModelIdentity,
  usage: TokenUsage | null,
  failed: boolean,
  requestFinishedAt: number = performance.now(),
): void => {
  ctx.backgroundScheduler(recordTokenUsage(ctx.apiKeyId, identity, usage).catch(error => {
    console.error('Failed to record usage:', error);
  }));
  recordPerformance(ctx, telemetry, failed, usage?.output ?? 0, requestFinishedAt);
};
