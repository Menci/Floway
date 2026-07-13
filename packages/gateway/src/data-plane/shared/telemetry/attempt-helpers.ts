import { isFirstOutputTokenFrame } from '../../chat/shared/first-output-token.ts';
import type { GatewayCtx } from '../../chat/shared/gateway-ctx.ts';
import { stampUpstreamCallStart } from '../../chat/shared/gateway-ctx.ts';
import type { ModelEndpoints, ProtocolFrame } from '@floway-dev/protocols/common';
import { eventResult, providerModelOf, readUpstreamApiError, type ChatTargetApi, type ExecuteResult, type ModelCandidate, type PerformanceOperation, type PerformanceTelemetryContext, type ProviderStreamResult, type TelemetryModelIdentity, type UpstreamCallOptions } from '@floway-dev/provider';

export const upstreamPerformanceContext = (
  ctx: GatewayCtx,
  candidate: ModelCandidate,
  operation: PerformanceOperation,
): PerformanceTelemetryContext => ({
  keyId: ctx.apiKeyId,
  model: candidate.model.id,
  upstream: candidate.provider.upstream,
  operation,
  runtimeLocation: ctx.runtimeLocation,
});

// Build a picker from an ordered preference list of chat-target keys. The
// preference encodes which upstream wire the source protocol prefers to
// translate to, in order. The first preference whose endpoint key exists
// on the candidate wins. Serve calls `canServe` to filter candidates whose
// upstream wire cannot satisfy any preferred target; attempt calls `pick`
// once it has a viable candidate to choose the dispatch wire. `pick` is
// contractually total — a null return would mean the serve-side filter
// was bypassed. `canServe` is a 1-bit projection of `pick`.
export const chatTargetPicker = (preference: readonly ChatTargetApi[]): {
  canServe: (endpoints: ModelEndpoints) => boolean;
  pick: (endpoints: ModelEndpoints) => ChatTargetApi;
} => {
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

// `model` is the upstream-facing bare id (`candidate.model.id`,
// e.g. `gpt-4o`) regardless of which surface form the client called
// (`or/gpt-4o` or `gpt-4o`). Usage and performance aggregates therefore key on
// the canonical upstream id, and a dashboard slice over `model` rolls up both
// surfaces of the same upstream model under one row.
export const telemetryModelIdentity = (candidate: ModelCandidate, modelKey: string): TelemetryModelIdentity => ({
  model: candidate.model.id,
  upstream: candidate.provider.upstream,
  modelKey,
  pricing: providerModelOf(candidate).pricing ?? null,
});

// See UpstreamCallOptions in `@floway-dev/provider` for the contract on each
// field, especially header ownership.
export const buildUpstreamCallOptions = (
  candidate: ModelCandidate,
  ctx: GatewayCtx,
  headers: Headers,
): UpstreamCallOptions => ({
  fetcher: candidate.fetcher,
  waitUntil: ctx.backgroundScheduler,
  headers,
  wrapUpstreamCall: stampUpstreamCallStart(ctx.attempt),
});

export const providerStreamResultToExecuteResult = async <TEvent>(
  providerResult: ProviderStreamResult<TEvent>,
  candidate: ModelCandidate,
  targetApi: ChatTargetApi,
  ctx: GatewayCtx,
): Promise<ExecuteResult<ProtocolFrame<TEvent>>> => {
  const context = upstreamPerformanceContext(ctx, candidate, 'chat');
  if (!providerResult.ok) {
    return { ...(await readUpstreamApiError(providerResult.response, candidate.provider.upstream)), performance: context };
  }
  const stampedEvents = (async function* () {
    for await (const frame of providerResult.events) {
      if (ctx.attempt.firstOutputTokenAt === null && isFirstOutputTokenFrame(frame, targetApi)) {
        ctx.attempt.firstOutputTokenAt = performance.now();
      }
      yield frame;
    }
  })();
  return eventResult(
    stampedEvents,
    telemetryModelIdentity(candidate, providerResult.modelKey),
    { performance: context, headers: providerResult.headers },
  );
};
