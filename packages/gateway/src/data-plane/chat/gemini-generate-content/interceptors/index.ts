import { stripSafetySettings } from './strip-safety-settings.ts';
import { stripUnsupportedPartFields } from './strip-unsupported-part-fields.ts';
import { stripUnsupportedTools } from './strip-unsupported-tools.ts';
import { suppressThoughtParts } from './suppress-thought-parts.ts';
import type { GeminiGenerateContentCountTokensInterceptor, GeminiGenerateContentInterceptor } from './types.ts';

// Unified Gemini generateContent interceptor list for `generate`. All four entries below are
// unconditional protocol-shape cleanups required because Gemini-generateContent-shape requests
// cannot ride verbatim through other targets, plus the post-stream thought
// suppression that hides Gemini-generateContent-native thought parts unless the caller opted
// in. There is no target-side companion list — Gemini generateContent has no native upstream
// in our provider API, so everything happens on the source side regardless of
// the chosen target.
export const geminiGenerateContentInterceptors: readonly GeminiGenerateContentInterceptor[] = [
  stripUnsupportedPartFields,
  stripUnsupportedTools,
  stripSafetySettings,
  suppressThoughtParts,
];

// countTokens always translates Gemini generateContent → Anthropic Messages and calls the Anthropic Messages
// count_tokens upstream, which returns a raw `Response` rather than an event
// stream. The shipped Gemini generateContent interceptors all either mutate the payload pre-
// dispatch (acceptable) or wrap the post-`run()` event stream (incompatible
// with the count-tokens result shape). `geminiGenerateContentAttempt.countTokens` applies
// the payload-mutators inline before handing the translated payload to the
// Anthropic Messages count_tokens path, so this list stays empty; the chain still runs
// so the count-tokens path keeps the same invocation envelope as generate.
export const geminiGenerateContentCountTokensInterceptors: readonly GeminiGenerateContentCountTokensInterceptor[] = [];
