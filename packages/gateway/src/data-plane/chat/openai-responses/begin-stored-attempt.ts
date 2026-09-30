import type { Fields } from './facts.ts';
import type { ChatServices } from '../services.ts';
import { defineStage } from '@floway-dev/pipeline';

/**
 * Each candidate starts with the hydrated private payloads. Hosted tools can add execution
 * state during that attempt; reseeding here prevents a failed candidate's state from leaking
 * into failover while preserving payloads when stored items are replayed.
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
