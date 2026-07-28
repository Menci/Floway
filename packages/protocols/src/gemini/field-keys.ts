import type { GeminiCandidate, GeminiResult } from './index.ts';

// These sets mark fields handled on typed paths during reassembly and affinity
// transport. Keeping one definition for both stages ensures unknown upstream
// fields remain extras until every stage gains typed handling for them.
export const GEMINI_RESULT_KEYS: ReadonlySet<keyof GeminiResult> = new Set(['candidates', 'modelVersion', 'responseId', 'usageMetadata']);
export const GEMINI_CANDIDATE_KEYS: ReadonlySet<keyof GeminiCandidate> = new Set(['index', 'content', 'finishReason', 'finishMessage', 'safetyRatings']);
