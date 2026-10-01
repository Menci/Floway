import type { ResponsesFacts } from '../../chat-facts.ts';
import { defineStage, move } from '@floway-dev/pipeline';

/**
 * Copilot's `/responses` rejects `store: true` with
 * `400 {"error":{"message":"store is not supported","code":"unsupported_value","param":"store"}}`.
 * Force `store: false` on the outgoing payload once planning has committed to
 * the Copilot OpenAI Responses target so the upstream accepts the request. The
 * gateway's own stored-items persistence keys off the caller's original `store`
 * value captured at parse time and is unaffected by this upstream-only flag.
 *
 * Generic in the run-result type so the same definition feeds both the
 * streaming `/responses` chain and the non-streaming compaction chain — the
 * synth-via-trigger compact call also rejects `store: true`.
 */

export const copilotOpenAIResponsesForceStoreFalse = defineStage<ResponsesFacts, ResponsesFacts, object, object>({
  name: 'copilotOpenAIResponsesForceStoreFalse',
  through: {
    request: { needs: ['request.provider.payload'], consumes: ['request.provider.payload'], provides: ['request.provider.payload'] },
    response: { needs: [], consumes: [], provides: [] },
  },
  execute: async (facts, next) => {
    let payload = facts['request.provider.payload'];

    payload = { ...payload, store: false };

    return move({ ...await next(move({ ...facts, 'request.provider.payload': payload })) });

  },
});
