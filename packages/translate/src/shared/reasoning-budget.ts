/**
 * Approximate numeric budgets using community effort-tier defaults as upper bounds.
 * The 2048 and 8192 thresholds are our heuristic; zero maps to none.
 * Google budget ranges: https://ai.google.dev/gemini-api/docs/thinking
 * Community tier defaults:
 * https://github.com/krzysztofdudek/AutoReview/blob/9bf2ede3a960f5215645bedba41c591829053f5c/scripts/lib/providers/google.mjs#L4
 * https://github.com/BerriAI/litellm/blob/88e03e548716a45284597edf2b7f47a7e6a66d5f/litellm/constants.py#L184
 */
export const reasoningEffortForBudget = (budget: number): string => {
  if (budget <= 0) return 'none';
  if (budget <= 2048) return 'low';
  if (budget <= 8192) return 'medium';
  return 'high';
};
