import { stripSafetySettings } from './strip-safety-settings.ts';
import { stripUnsupportedPartFields } from './strip-unsupported-part-fields.ts';
import { stripUnsupportedTools } from './strip-unsupported-tools.ts';
import { suppressThoughtParts } from './suppress-thought-parts.ts';
import type { GeminiCountTokensInterceptor, GeminiInterceptor } from './types.ts';

// Unified Gemini interceptor list for `generate`. All four entries below are
// unconditional protocol-shape cleanups required because Gemini-shape requests
// cannot ride verbatim through other targets, plus the post-stream thought
// suppression that hides Gemini-native thought parts unless the caller opted
// in. There is no target-side companion list — Gemini has no native upstream
// in our provider API, so everything happens on the source side regardless of
// the chosen target.
export const geminiInterceptors: readonly GeminiInterceptor[] = [
  stripUnsupportedPartFields,
  stripUnsupportedTools,
  stripSafetySettings,
  suppressThoughtParts,
];

// countTokens always translates Gemini → Messages and calls the Messages
// count_tokens upstream, which returns a raw `Response` rather than an event
// stream. The shipped Gemini interceptors all either mutate the payload pre-
// dispatch (acceptable) or wrap the post-`run()` event stream (incompatible
// with the count-tokens result shape). `geminiAttempt.countTokens` applies
// the payload-mutators inline before handing the translated payload to the
// Messages count_tokens path, so this list stays empty; the chain still runs
// so the count-tokens path keeps the same invocation envelope as generate.
export const geminiCountTokensInterceptors: readonly GeminiCountTokensInterceptor[] = [];
