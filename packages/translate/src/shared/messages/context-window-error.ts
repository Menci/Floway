import type { TranslatedApiError } from '../../types.ts';

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

// Structural + textual detector for context-exceeded error bodies coming from
// any OpenAI-shaped upstream. Codes take precedence; message substrings are a
// fallback for shapes where the code was renamed or omitted.
//
// Coverage (all captured live or from vendor fixtures):
//
// - Copilot Responses / Chat Completions (HTTP 400):
//     {"error":{"code":"model_max_prompt_tokens_exceeded","message":"prompt token count of N exceeds the limit of M"}}
// - Codex Responses unary (HTTP 400):
//     {"error":{"code":"context_length_exceeded","message":"Your input exceeds the context window of this model. ..."}}
// - Codex Responses streaming SSE `response.failed` frame:
//     data: {..., "response": {..., "error":{"code":"context_length_exceeded", "message":"..."}}}
//     — https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/sse/responses.rs
// - Canonical OpenAI Chat Completions:
//     {"error":{"code":"context_length_exceeded","type":"invalid_request_error","message":"This model's maximum context length is ..."}}
// - Copilot `/v1/messages` (Anthropic-shaped body carrying a Copilot-specific
//   message string):
//     {"type":"error","error":{"type":"invalid_request_error","message":"Request body is too large for model context window ..."}}
//   The provider-copilot Messages interceptor handles this at the provider
//   layer; the substring is listed here so a Messages-via-Responses trip that
//   ever encounters the same phrasing behaves consistently.

const codeIsContextExceeded = (code: unknown): boolean =>
  code === 'context_length_exceeded' || code === 'model_max_prompt_tokens_exceeded';

const messageIsContextExceeded = (message: unknown): boolean =>
  typeof message === 'string'
  && (message.includes('exceeds the context window of this model')
    || message.includes('maximum context length is')
    || message.includes('Request body is too large for model context window'));

interface MaybeErrorFields {
  code?: unknown;
  message?: unknown;
}

interface MaybeErrorBody {
  error?: MaybeErrorFields;
}

export const isContextExceededError = (error: MaybeErrorFields | undefined | null): boolean => {
  if (error === undefined || error === null) return false;
  return codeIsContextExceeded(error.code) || messageIsContextExceeded(error.message);
};

export const isContextExceededErrorObject = (parsed: unknown): boolean => {
  if (parsed === null || typeof parsed !== 'object') return false;
  return isContextExceededError((parsed as MaybeErrorBody).error);
};

export const isContextExceededErrorText = (text: string): boolean => {
  try {
    return isContextExceededErrorObject(JSON.parse(text));
  } catch {
    return messageIsContextExceeded(text);
  }
};

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

// Shared `TranslateTrip.apiError` implementation for the `messages-via-*`
// pairs. Rewrites an upstream context-exceeded body into an Anthropic
// prompt-too-long envelope; passes anything else through unchanged.
export const rewriteContextExceededToPromptTooLong = (upstream: TranslatedApiError): TranslatedApiError | undefined => {
  if (!isContextExceededErrorText(new TextDecoder().decode(upstream.body))) return undefined;
  return {
    status: 400,
    headers: new Headers({ 'content-type': 'application/json' }),
    body: buildPromptTooLongBody(),
  };
};
