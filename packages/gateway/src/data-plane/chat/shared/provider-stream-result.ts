import { isFirstOutputTokenFrame } from './first-output-token.ts';
import type { GatewayCtx } from '../../shared/gateway-ctx.ts';
import { telemetryModelIdentity, upstreamPerformanceContext } from '../../shared/telemetry/attribution.ts';
import type { BillableUsage, ProtocolFrame } from '@floway-dev/protocols/common';
import { eventResult, readUpstreamApiError, type ChatTargetApi, type EventResultMetadata, type ExecuteResult, type ModelCandidate, type ProviderStreamResult } from '@floway-dev/provider';

export const providerStreamResultToExecuteResult = async <TEvent>(
  providerResult: ProviderStreamResult<TEvent>,
  candidate: ModelCandidate,
  targetApi: ChatTargetApi,
  ctx: GatewayCtx,
  // Reads the upstream's own usage off one of its events, in the upstream's
  // own protocol. This is the only place pricing figures are produced; nothing
  // downstream re-derives them from the translated result the client receives.
  readBillableUsage: (event: TEvent) => BillableUsage | null,
): Promise<ExecuteResult<ProtocolFrame<TEvent>>> => {
  const context = upstreamPerformanceContext(ctx, candidate, 'chat');
  if (!providerResult.ok) {
    return { ...(await readUpstreamApiError(providerResult.response, candidate.provider.upstreamId)), performance: context };
  }
  const identity = telemetryModelIdentity(candidate, providerResult.modelKey);
  let resolveFinal!: (metadata: EventResultMetadata) => void;
  const finalMetadata = new Promise<EventResultMetadata>(resolve => { resolveFinal = resolve; });
  // Only a report carrying real counts replaces the running figure, so a
  // trailing empty usage frame cannot wipe a good one. Held outside the
  // generator so final metadata can resolve after the transport drains the
  // complete upstream stream.
  let billableUsage: BillableUsage | undefined;
  const settleMetadata = (): void => resolveFinal({
    modelIdentity: identity,
    ...(context !== undefined ? { performance: context } : {}),
    ...(billableUsage !== undefined ? { billableUsage } : {}),
  });
  const observeFrame = (frame: ProtocolFrame<TEvent>): void => {
    if (ctx.attempt.firstOutputTokenAt === null && isFirstOutputTokenFrame(frame, targetApi)) {
      ctx.attempt.firstOutputTokenAt = performance.now();
    }
    if (frame.type === 'event') {
      const reported = readBillableUsage(frame.event);
      if (reported !== null) billableUsage = reported;
    }
  };
  const stampedEvents = (async function* () {
    // Downstream protocol wrappers are allowed to finish at their terminal
    // event. Keep ownership of the provider iterator here so IteratorClose
    // still consumes trailing usage and transport sentinels before metadata
    // settles.
    const iterator = providerResult.events[Symbol.asyncIterator]();
    let sourceOpen = true;
    const readSource = async (): Promise<IteratorResult<ProtocolFrame<TEvent>>> => {
      let next: IteratorResult<ProtocolFrame<TEvent>>;
      try {
        next = await iterator.next();
      } catch (error) {
        sourceOpen = false;
        throw error;
      }
      if (next.done) sourceOpen = false;
      else observeFrame(next.value);
      return next;
    };
    try {
      while (true) {
        const next = await readSource();
        if (next.done) break;
        yield next.value;
      }
    } finally {
      try {
        while (sourceOpen) await readSource();
      } finally {
        settleMetadata();
      }
    }
  })();
  return {
    ...eventResult(stampedEvents, identity, { performance: context, headers: providerResult.headers }),
    finalMetadata,
  };
};
