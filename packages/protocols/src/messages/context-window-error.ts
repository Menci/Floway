// Anthropic Messages envelope emitted for any context-exceeded upstream. The
// leading `prompt is too long` substring is the load-bearing part: Claude
// Code's context-exceeded detector is a case-insensitive substring match on
// `error.message`, running
//
//   error.message.toLowerCase().includes('prompt is too long')
//   error.message.toLowerCase().includes('input length and `max_tokens` exceed context limit')
//
// on whatever Error the SDK raises — same predicate for streaming and
// non-streaming; `error.type` and the HTTP status are NOT inspected. A hit
// routes into the internal `prompt_too_long` category and triggers
// auto-compaction (telemetry event `tengu_compact_ptl_retry`). Evidence:
// grep the shipped `@anthropic-ai/claude-code` v2.1.207 binary (build
// fingerprint `bc512d5`, built 2026-07-10) — the two predicates sit next
// to the `Prompt is too long` string constant. The client's source is
// Anthropic-private, so the shipped bundle is the only public artefact
// that verifies this behaviour; the docs summary at
// https://docs.claude.com/en/docs/claude-code/common-workflows#prompt-too-long
// covers the user-facing symptom without spelling out the predicate.
export const PROMPT_TOO_LONG_MESSAGE =
  'prompt is too long: your prompt is too long. Please reduce the number of messages or use a model with a larger context window.';

// Byte-shape mirrors the Anthropic-direct error envelope. Only the
// `prompt is too long` substring inside `error.message` is load-bearing for
// Claude Code's auto-compaction gate (see PROMPT_TOO_LONG_MESSAGE above);
// the `invalid_request_error` type matches Anthropic-direct convention but
// is not part of the detector.
export const buildPromptTooLongBody = (): Uint8Array =>
  new TextEncoder().encode(JSON.stringify({
    type: 'error',
    error: { type: 'invalid_request_error', message: PROMPT_TOO_LONG_MESSAGE },
  }));
