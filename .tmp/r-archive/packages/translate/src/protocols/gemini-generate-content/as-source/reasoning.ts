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
