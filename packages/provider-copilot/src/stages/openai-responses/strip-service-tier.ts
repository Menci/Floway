import type { ResponsesFacts } from '../../chat-facts.ts';
import { defineStage, move } from '@floway-dev/pipeline';

/**
 * Copilot has no request-side `service_tier`: `/responses` answers any value
 * of the field with HTTP 400
 * `{"code":"unsupported_value","param":"service_tier"}`, on a base id and a
 * `-fast` id alike. The tier reaches the upstream as the raw model id
 * model selection selected instead, so by the time this runs the value
 * has already been consumed and only the unusable field is left to drop.
 * Strip it only after planning has committed to the OpenAI Responses target
 * so source-side behavior and telemetry still see the caller's original
 * request. Generic in the run-result type so the same definition feeds both
 * the streaming `/responses` chain and the non-streaming compaction chain.
 *
 * References:
 * - https://github.com/caozhiyuan/copilot-api/commit/f7835a44f06976cab874700e4d94a5f5c0379369
 * - https://platform.openai.com/docs/api-reference/responses/create
 */

export const copilotOpenAIResponsesStripServiceTier = defineStage<ResponsesFacts, ResponsesFacts, object, object>({
  name: 'copilotOpenAIResponsesStripServiceTier',
  through: {
    request: { needs: ['request.provider.payload'], consumes: ['request.provider.payload'], provides: ['request.provider.payload'] },
    response: { needs: [], consumes: [], provides: [] },
  },
  execute: async (facts, next) => {
    let payload = facts['request.provider.payload'];

    const { service_tier: _, ...withoutTier } = payload;
    payload = withoutTier;

    return move({ ...await next(move({ ...facts, 'request.provider.payload': payload })) });

  },
});
