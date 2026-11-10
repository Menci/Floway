import type { GeminiGenerateContentThinkingConfig } from '@floway-dev/protocols/gemini-generate-content';

// Translate Google's named thinking levels to target effort names; the default
// sentinel leaves effort unset. Preserve all other open-string values verbatim.
// Reference: https://ai.google.dev/api/generate-content#ThinkingLevel
export const geminiGenerateContentThinkingLevelEffort = (thinkingConfig?: GeminiGenerateContentThinkingConfig): string | undefined => {
  switch (thinkingConfig?.thinkingLevel) {
  case 'LOW': return 'low';
  case 'MEDIUM': return 'medium';
  case 'HIGH': return 'high';
  case 'MINIMAL': return 'minimal';
  case 'THINKING_LEVEL_UNSPECIFIED': return undefined;
  default: return thinkingConfig?.thinkingLevel;
  }
};

// Bucket Gemini generateContent's numeric `thinkingBudget` back onto the discrete
// `reasoning_effort` axis when the target protocol has no numeric budget
// slot (OpenAI Chat Completions, OpenAI Responses). Google publishes per-model
// budget ranges but not effort-name thresholds; the 2048 / 8192 bin
// edges below invert the community convention of using those same
// numbers as the DEFAULT budget per effort tier — treating "medium's
// default is 2048" as "budgets up to and including 2048 read as low
// tier", and "high's default is 8192" as "budgets up to 8192 read as
// medium tier".
//
// References:
// - Google Gemini thinking config: https://ai.google.dev/gemini-api/docs/thinking
// - AutoReview (community): `THINK_BUDGETS = { low: 512, medium: 2048, high: 8192 }`
//   https://github.com/krzysztofdudek/AutoReview/blob/9bf2ede3a960f5215645bedba41c591829053f5c/scripts/lib/providers/google.mjs#L4
// - LiteLLM (community): `DEFAULT_REASONING_EFFORT_MEDIUM_THINKING_BUDGET = 2048`
//   https://github.com/BerriAI/litellm/blob/88e03e548716a45284597edf2b7f47a7e6a66d5f/litellm/constants.py#L184
export const geminiGenerateContentReasoningEffort = (thinkingConfig?: GeminiGenerateContentThinkingConfig): string | null => {
  if (!thinkingConfig) return null;

  if (thinkingConfig.thinkingBudget !== undefined) {
    if (thinkingConfig.thinkingBudget === 0) return 'none';
    if (thinkingConfig.thinkingBudget < 0) return null;
    if (thinkingConfig.thinkingBudget <= 2048) return 'low';
    if (thinkingConfig.thinkingBudget <= 8192) return 'medium';
    return 'high';
  }

  return geminiGenerateContentThinkingLevelEffort(thinkingConfig) ?? null;
};
