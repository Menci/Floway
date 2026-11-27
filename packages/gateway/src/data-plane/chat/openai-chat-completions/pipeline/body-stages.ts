import { normalizeOpenAIChatCompletionsToolChoice } from './empty-tools-tool-choice.ts';
import { includeOpenAIChatCompletionsUsage } from './include-usage.ts';
import { stripOpenAIChatCompletionsPromptCacheKey } from './prompt-cache-key.ts';
import { disableOpenAIChatCompletionsForcedToolReasoning } from './reasoning-tool-choice.ts';

export const openaiChatCompletionsBodyStages = [
  includeOpenAIChatCompletionsUsage,
  disableOpenAIChatCompletionsForcedToolReasoning,
  normalizeOpenAIChatCompletionsToolChoice,
  stripOpenAIChatCompletionsPromptCacheKey,
] as const;
