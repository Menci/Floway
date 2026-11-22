import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';

/**
 * Copilot has no request-side `service_tier`: `/responses` answers any value
 * of the field with HTTP 400
 * `{"code":"unsupported_value","param":"service_tier"}`, on a base id and a
 * `-fast` id alike. The tier reaches the upstream as the raw model id
 * The Responses pipeline selects instead, so the value has already been
 * consumed and only the unusable field is left to drop.
 * Strip it only after planning has committed to the OpenAI Responses target
 * so source-side behavior and telemetry still see the caller's original
 * request. Both streaming generation and compaction use this transform.
 *
 * References:
 * - https://github.com/caozhiyuan/copilot-api/commit/f7835a44f06976cab874700e4d94a5f5c0379369
 * - https://platform.openai.com/docs/api-reference/responses/create
 */
export const stripCopilotServiceTier = (payload: CanonicalOpenAIResponsesPayload): CanonicalOpenAIResponsesPayload => {
  const { service_tier: _serviceTier, ...withoutServiceTier } = payload;
  return withoutServiceTier;
};
