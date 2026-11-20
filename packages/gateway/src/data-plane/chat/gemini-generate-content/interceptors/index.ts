import { stripSafetySettings } from './strip-safety-settings.ts';
import { stripUnsupportedPartFields } from './strip-unsupported-part-fields.ts';
import { stripUnsupportedTools } from './strip-unsupported-tools.ts';
import { suppressThoughtParts } from './suppress-thought-parts.ts';
import type { GeminiGenerateContentCountTokensInterceptor, GeminiGenerateContentInterceptor } from './types.ts';

// The payload-shape cleanups every Gemini request needs before it can be
// translated: another wire has no slot for file/code parts, non-function tool
// groups, or safety settings. Each entry is a no-op when Gemini itself is the
// target, so a native upstream receives the payload as the client shaped it.
//
// Both operations run this exact list in this order. Each entry is generic over
// the chain result, which it passes through untouched, so the same value types
// as either operation's interceptor list.
const shapeCleanup = [stripUnsupportedPartFields, stripUnsupportedTools, stripSafetySettings] as const;

// The full `generate` chain. Thought suppression runs after the turn: it hides
// thought summaries a translated target surfaced unless the caller opted in,
// while a native upstream decides for itself from the same flag.
export const geminiGenerateContentInterceptors: readonly GeminiGenerateContentInterceptor[] = [
  ...shapeCleanup,
  suppressThoughtParts,
];

// countTokens reaches a native Gemini upstream when the candidate declares one
// and otherwise translates to Anthropic Messages count_tokens. It runs the same
// shape cleanups and stops before thought suppression, which inspects an event
// stream this result type cannot carry.
export const geminiGenerateContentCountTokensInterceptors: readonly GeminiGenerateContentCountTokensInterceptor[] =
  shapeCleanup;
