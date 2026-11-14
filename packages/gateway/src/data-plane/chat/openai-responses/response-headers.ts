// Codex treats the presence of this response header as the signal that the
// server-reported usage already accounts for historical encrypted reasoning,
// so the client must not add its own estimate before deciding to compact.
// https://github.com/openai/codex/blob/a9b0815167c27ab13719dd12d13b63e02b70d221/codex-rs/codex-api/src/sse/responses.rs#L31-L87
// https://github.com/openai/codex/blob/a9b0815167c27ab13719dd12d13b63e02b70d221/codex-rs/codex-api/src/endpoint/responses_websocket.rs#L489-L539
export const OPENAI_RESPONSES_REASONING_INCLUDED_HEADER = 'x-reasoning-included';

export const OPENAI_RESPONSES_REASONING_INCLUDED_VALUE = 'true';
