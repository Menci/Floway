import { isFirstOutputTokenFrame } from './first-output-token.ts';
import type { GatewayCtx } from '../../shared/gateway-ctx.ts';
import { telemetryModelIdentity, upstreamPerformanceContext } from '../../shared/telemetry/attribution.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import { eventResult, readUpstreamApiError, type ChatTargetApi, type ExecuteResult, type ModelCandidate, type ProviderStreamResult } from '@floway-dev/provider';

// Lowers a provider's stream into the chain's currency and stamps the
// attribution that belongs to the call itself: which upstream model answered,
// and when its first output token arrived. What the turn cost is not read
// here — the usage on these frames is still in the upstream's own dialect,
// and `meteringBillableUsage` reads it above the interceptors that normalize
// it.
export const providerStreamResultToExecuteResult = async <TEvent>(
  providerResult: ProviderStreamResult<TEvent>,
  candidate: ModelCandidate,
  targetApi: ChatTargetApi,
  ctx: GatewayCtx,
): Promise<ExecuteResult<ProtocolFrame<TEvent>>> => {
  const context = upstreamPerformanceContext(ctx, candidate, 'chat');
  if (!providerResult.ok) {
    return { ...(await readUpstreamApiError(providerResult.response, candidate.provider.upstreamId)), performance: context };
  }
  const stampedEvents = (async function* () {
    for await (const frame of providerResult.events) {
      if (ctx.attempt.firstOutputTokenAt === null && isFirstOutputTokenFrame(frame, targetApi)) {
        ctx.attempt.firstOutputTokenAt = performance.now();
      }
      yield frame;
    }
  })();
  return eventResult(stampedEvents, telemetryModelIdentity(candidate, providerResult.modelKey), {
    performance: context,
    headers: providerResult.headers,
  });
};
