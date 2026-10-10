import { firstOutputTokenSignal } from './first-output-token.ts';
import type { GatewayCtx } from '../../shared/gateway-ctx.ts';
import { telemetryModelIdentity } from '../../shared/telemetry/attribution.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ChatTargetApi, ModelCandidate } from '@floway-dev/provider';

export const observeFirstOutputToken = (
  frame: ProtocolFrame<unknown>,
  modelKey: string,
  candidate: ModelCandidate,
  targetApi: ChatTargetApi,
  ctx: GatewayCtx,
): void => {
  if (ctx.abortSignal?.aborted || ctx.attempt.outputObservationUnavailable || ctx.attempt.timing.firstOutputTokenAt !== null) return;
  const signal = firstOutputTokenSignal(frame, targetApi);
  if (signal === null) return;
  ctx.attempt.timing.firstOutputTokenAt = performance.now();
  if (signal.type === 'runtime-output') {
    const identity = telemetryModelIdentity(candidate, modelKey);
    console.warn('Floway: first output timing started from runtime output without an earlier decode signal in this response', {
      outputType: signal.outputType,
      upstream: identity.upstream,
      model: identity.model,
      modelKey: identity.modelKey,
    });
  }
};
