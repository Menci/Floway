import { stripGeminiGenerateContentSafetySettings } from './safety-settings.ts';
import { suppressGeminiGenerateContentThoughtParts } from './thought-parts.ts';
import { stripGeminiGenerateContentUnsupportedPartFields } from './unsupported-part-fields.ts';
import { stripGeminiGenerateContentUnsupportedTools } from './unsupported-tools.ts';

export const geminiGenerateContentBodyStages = [
  stripGeminiGenerateContentUnsupportedPartFields,
  stripGeminiGenerateContentUnsupportedTools,
  stripGeminiGenerateContentSafetySettings,
  suppressGeminiGenerateContentThoughtParts,
] as const;
