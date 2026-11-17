import { stripSafetySettings } from './strip-safety-settings.ts';
import { stripUnsupportedPartFields } from './strip-unsupported-part-fields.ts';
import { stripUnsupportedTools } from './strip-unsupported-tools.ts';
import { suppressThoughtParts } from './suppress-thought-parts.ts';
import type { GeminiGenerateContentCountTokensInterceptor, GeminiGenerateContentInterceptor } from './types.ts';

// Unified Gemini generateContent interceptor list for `generate`. The three
// shape cleanups only act when the turn is translated: a native Gemini
// upstream receives the client's payload as shaped, while any other target
// cannot express file/code parts, non-function tool groups, or safety
// settings. Thought suppression runs after the turn either way, hiding thought
// summaries unless the caller opted in; a native upstream's own parts flow
// through it unchanged otherwise.
export const geminiGenerateContentInterceptors: readonly GeminiGenerateContentInterceptor[] = [
  stripUnsupportedPartFields,
  stripUnsupportedTools,
  stripSafetySettings,
  suppressThoughtParts,
];

// countTokens reaches a native Gemini upstream when the candidate declares one
// and otherwise translates to Anthropic Messages count_tokens, both returning a
// raw `Response` rather than an event stream. The shipped generate interceptors
// either mutate the payload pre-dispatch (acceptable) or wrap the post-`run()`
// event stream (incompatible with the count-tokens result shape), and the
// translated branch applies the payload mutators inline, so this list stays
// empty; the chain still runs so the count-tokens path keeps the same
// invocation envelope as generate.
export const geminiGenerateContentCountTokensInterceptors: readonly GeminiGenerateContentCountTokensInterceptor[] = [];
