import type { ChatCompletionsBoundaryCtx } from './types.ts';

// OpenAI Chat Completions fields the Cursor agent endpoint does not honor.
// Cursor's RunSSE+BidiAppend is an agent loop, not a raw completion API:
// sampling params (temperature/top_p) and turn limits (max_tokens) are
// agent-decided, and structured-output / advanced knobs are rejected. We strip
// them at the Cursor target boundary so source-protocol translators can keep
// setting them for other providers. `tools` / `tool_choice` / `stream` /
// `messages` / `model` are retained.
const CURSOR_UNSUPPORTED_BODY_FIELDS = [
  'response_format',
  'seed',
  'n',
  'user',
  'metadata',
  'frequency_penalty',
  'presence_penalty',
  'service_tier',
  'temperature',
  'top_p',
  'max_tokens',
  'reasoning_effort',
  'prompt_cache_key',
  'safety_identifier',
  'parallel_tool_calls',
  'stream_options',
] as const;

export const stripUnsupportedFields = async <TResult>(
  ctx: ChatCompletionsBoundaryCtx,
  _request: object,
  run: () => Promise<TResult>,
): Promise<TResult> => {
  const next: Record<string, unknown> = { ...(ctx.payload as unknown as Record<string, unknown>) };
  for (const key of CURSOR_UNSUPPORTED_BODY_FIELDS) delete next[key];
  ctx.payload = next as unknown as typeof ctx.payload;
  return await run();
};
