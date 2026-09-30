import type { ChatServices } from './services.ts';
import type { Slice } from './stage-contracts.ts';
import { defineStage, move } from '@floway-dev/pipeline';

/**
 * Puts the payload this attempt is owed into the record.
 *
 * Affinity materializes one per candidate — client-carried state rewritten for the upstream
 * that will see it — and it has to enter the record here rather than be read by the stage
 * that dials, because everything between this stage and the dial rewrites the request as a
 * fact. An ending that asked the resolver instead would be reading a payload no rule
 * had touched, and the rewrites would go nowhere.
 *
 * It sits below the fork because there is no single payload above it: each candidate has its
 * own, and re-running the suffix is what produces the next one.
 */
export const materializeAttempt = (requestKey: string) => defineStage<
  Slice<'route.attempt'>,
  Record<string, unknown>,
  Record<string, unknown>,
  Record<string, unknown>,
  ChatServices
>({
  name: `materializeAttempt:${requestKey}`,
  through: {
    request: { needs: ['route.attempt'], consumes: [], provides: [requestKey] },
    response: { needs: [], consumes: [], provides: [] },
  },
  execute: async (facts, next, use) =>
    await next({ ...facts, [requestKey]: move(use.chatPayloadFor(facts['route.attempt'])) }),
});
