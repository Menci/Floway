import type { GatewayCtx } from './gateway-ctx.ts';
import { recordUpstreamHttpFailure, upstreamPerformanceContext, withUpstreamTelemetry } from './upstream-telemetry.ts';
import { requireRecordedDurationMs, type UpstreamLatencyRecorder } from '../../shared/telemetry/performance.ts';
import type { ModelEndpoints, ProtocolFrame } from '@floway-dev/protocols/common';
import { eventResult, readUpstreamApiError, type ChatTargetApi, type ExecuteResult, type ProviderCandidate, type ProviderStreamResult, type TelemetryModelIdentity, type UpstreamCallOptions } from '@floway-dev/provider';

// Per-protocol chat-target picker. Serve calls `canServe` to filter
// candidates whose upstream wire cannot satisfy any preferred target;
// attempt calls `pick` once it has a viable candidate to choose which
// upstream wire the dispatch goes out on. `pick` is contractually total —
// a call that returns null would mean the serve-side filter was bypassed.
export interface ChatTargetPicker {
  canServe(endpoints: ModelEndpoints): boolean;
  pick(endpoints: ModelEndpoints): ChatTargetApi;
}

// Build a picker from an ordered preference list of chat-target keys. The
// preference encodes which upstream wire the source protocol prefers to
// translate to, in order. The first preference whose endpoint key exists
// on the candidate wins. `canServe` is a 1-bit projection of `pick`.
export const chatTargetPicker = (preference: readonly ChatTargetApi[]): ChatTargetPicker => {
  const find = (endpoints: ModelEndpoints): ChatTargetApi | null => {
    for (const key of preference) {
      switch (key) {
      case 'messages':
        if (endpoints.messages) return 'messages';
        break;
      case 'responses':
        if (endpoints.responses) return 'responses';
        break;
      case 'chat-completions':
        if (endpoints.chatCompletions) return 'chat-completions';
        break;
      }
    }
    return null;
  };
  return {
    canServe: endpoints => find(endpoints) !== null,
    pick: endpoints => {
      const out = find(endpoints);
      if (out === null) throw new Error('chatTargetPicker.pick called on a candidate the picker rejects — serve must filter via canServe first');
      return out;
    },
  };
};

// Telemetry identity for the chosen candidate plus the upstream-reported
// model key. Pricing reads off the provider so the cost lookup respects any
// provider-specific override.
//
// `model` is the upstream-facing bare id (`candidate.model.id`,
// e.g. `gpt-4o`) regardless of which surface form the client called
// (`or/gpt-4o` or `gpt-4o`). Usage and performance aggregates therefore key on
// the canonical upstream id, and a dashboard slice over `model` rolls up both
// surfaces of the same upstream model under one row.
export const telemetryModelIdentity = (candidate: ProviderCandidate, modelKey: string): TelemetryModelIdentity => ({
  model: candidate.model.id,
  upstream: candidate.provider.upstream,
  modelKey,
  cost: candidate.provider.provider.getPricingForModelKey(modelKey),
});

// Per-call UpstreamCallOptions for the chosen candidate; see
// UpstreamCallOptions in `@floway-dev/provider` for the contract on each
// field, especially header ownership.
export const buildUpstreamCallOptions = (
  candidate: ProviderCandidate,
  ctx: GatewayCtx,
  recordUpstreamLatency: UpstreamCallOptions['recordUpstreamLatency'],
  headers: Headers,
): UpstreamCallOptions => ({
  fetcher: candidate.fetcher,
  recordUpstreamLatency,
  waitUntil: ctx.backgroundScheduler,
  headers,
});

// Lifts a provider's streaming-call result into the attempt's ExecuteResult
// shape, attaching the performance telemetry context every layer above reads:
// a non-ok provider response is read into an `api-error` (source 'upstream')
// carrying the context (and records its `upstream_success` failure),
// otherwise the events stream is wrapped with upstream telemetry and flows on
// with both the telemetry identity and the context.
//
// The recorder enters via the ok=true branch only: success requires a real
// upstream round-trip, so durationMs is asserted at use. The ok=false
// branch carries no latency today — the failure metric scope is counter-only
// — and so doesn't consult the recorder.
export const providerStreamResultToExecuteResult = async <TEvent>(
  providerResult: ProviderStreamResult<TEvent>,
  candidate: ProviderCandidate,
  targetApi: ChatTargetApi,
  ctx: GatewayCtx,
  recorder: UpstreamLatencyRecorder,
): Promise<ExecuteResult<ProtocolFrame<TEvent>>> => {
  const context = upstreamPerformanceContext(ctx, candidate, providerResult.modelKey);
  if (!providerResult.ok) {
    recordUpstreamHttpFailure(ctx, context);
    return { ...(await readUpstreamApiError(providerResult.response, candidate.provider.upstream)), performance: context };
  }
  return eventResult(
    withUpstreamTelemetry(providerResult.events, ctx, context, targetApi, requireRecordedDurationMs(recorder, 'upstream success')),
    telemetryModelIdentity(candidate, providerResult.modelKey),
    { performance: context, headers: providerResult.headers },
  );
};
