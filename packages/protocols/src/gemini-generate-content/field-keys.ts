import type { GeminiGenerateContentCandidate, GeminiGenerateContentResult } from './index.ts';

// These sets mark fields handled on typed paths during reassembly and affinity
// transport. Keeping one definition for both stages ensures unknown upstream
// fields remain extras until every stage gains typed handling for them.
export const GEMINI_GENERATE_CONTENT_RESULT_KEYS: ReadonlySet<keyof GeminiGenerateContentResult> = new Set(['candidates', 'modelVersion', 'responseId', 'usageMetadata']);
export const GEMINI_GENERATE_CONTENT_CANDIDATE_KEYS: ReadonlySet<keyof GeminiGenerateContentCandidate> = new Set(['index', 'content', 'finishReason', 'finishMessage', 'safetyRatings']);
