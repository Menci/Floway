/**
 * Approximates a token budget as one of the discrete effort names the OpenAI
 * protocols accept.
 *
 * Those protocols have no numeric budget slot, so a caller that capped the
 * budget without naming a level can only be reported at the nearest tier.
 * Google publishes per-model budget ranges but not effort-name thresholds; the
 * 2048 / 8192 edges below invert the community convention of using those same
 * numbers as the DEFAULT budget per effort tier — treating "medium's default is
 * 2048" as "budgets up to and including 2048 read as the low tier", and "high's
 * default is 8192" as "budgets up to 8192 read as the medium tier".
 *
 * References:
 * - Google Gemini thinking config: https://ai.google.dev/gemini-api/docs/thinking
 * - AutoReview (community): `THINK_BUDGETS = { low: 512, medium: 2048, high: 8192 }`
 *   https://github.com/krzysztofdudek/AutoReview/blob/9bf2ede3a960f5215645bedba41c591829053f5c/scripts/lib/providers/google.mjs#L4
 * - LiteLLM (community): `DEFAULT_REASONING_EFFORT_MEDIUM_THINKING_BUDGET = 2048`
 *   https://github.com/BerriAI/litellm/blob/88e03e548716a45284597edf2b7f47a7e6a66d5f/litellm/constants.py#L184
 *
 * A budget of zero asks for no reasoning at all, which those protocols spell as
 * `none`.
 */
export const reasoningEffortForBudget = (budget: number): string => {
  if (budget <= 0) return 'none';
  if (budget <= 2048) return 'low';
  if (budget <= 8192) return 'medium';
  return 'high';
};
