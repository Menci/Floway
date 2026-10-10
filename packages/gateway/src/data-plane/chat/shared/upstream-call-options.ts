import { observeFirstOutputToken } from './first-output-token-observer.ts';
import type { GatewayCtx } from '../../shared/gateway-ctx.ts';
import { buildUpstreamCallOptions } from '../../shared/upstream-call-options.ts';
import type { ChatTargetApi, ModelCandidate, UpstreamCallOptions } from '@floway-dev/provider';

export const buildChatUpstreamCallOptions = (
  candidate: ModelCandidate,
  ctx: GatewayCtx,
  headers: Headers,
  targetApi: ChatTargetApi,
): UpstreamCallOptions => ({
  ...buildUpstreamCallOptions(candidate, ctx, headers),
  // Observe parsed upstream frames before provider-owned identity rewrites can
  // wait for an item's complete payload and defer an already-arrived signal.
  observeStreamFrame: (frame, modelKey) => { observeFirstOutputToken(frame, modelKey, candidate, targetApi, ctx); },
});
