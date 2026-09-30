import type { Fields } from './facts.ts';
import type { ChatServices } from '../services.ts';
import { defineStage } from '@floway-dev/pipeline';

/**
 * Reseeds the store's per-attempt scratchpad from what the membrane hydrated.
 *
 * Below the fork because it is per attempt: what one attempt wrote into the scratchpad is
 * not what the next one starts from, and re-running the suffix is what clears it. Nothing in
 * a pipelined turn writes to it — the hosted-tool shim is what writes, and it does not run at
 * all — so today this only puts back the state the stored rows already carried, which is what
 * lets an item this turn re-emits be stored with it intact.
 */
export const beginStoredAttempt = defineStage<
  Fields<'request.chat.openaiResponses.privatePayloads'>,
  Fields<'request.chat.openaiResponses.privatePayloads'>,
  Record<string, never>,
  Record<string, never>,
  ChatServices
>({
  name: 'beginStoredAttempt',
  through: {
    request: { needs: ['request.chat.openaiResponses.privatePayloads'], consumes: [], provides: [] },
    response: { needs: [], consumes: [], provides: [] },
  },
  execute: async (facts, next, use) => {
    use.gateway.store.beginAttempt(new Map(facts['request.chat.openaiResponses.privatePayloads']));
    return await next(facts);
  },
});
