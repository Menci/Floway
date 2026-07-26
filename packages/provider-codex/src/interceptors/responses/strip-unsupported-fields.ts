import type { ResponsesBoundaryCtx } from './types.ts';

// Codex backend rejects requests carrying any of these fields with a
// `Unsupported parameter: <name>` 4xx. They are regular OpenAI Responses API
// fields that the ChatGPT-subscription path does not honor. Source-protocol
// translators legitimately set max_output_tokens / temperature / top_p (the
// caller's request might carry them), so we strip them at the Codex target
// boundary rather than at translation time, where they remain valid for
// other providers.
const CODEX_UNSUPPORTED_BODY_FIELDS = [
  'max_output_tokens',
  'temperature',
  'top_p',
  'frequency_penalty',
  'presence_penalty',
  'user',
  'metadata',
  'prompt_cache_retention',
  'safety_identifier',
  'stream_options',
] as const;

export const stripUnsupportedFields = async <TResult>(
  ctx: ResponsesBoundaryCtx,
  _env: object,
  run: () => Promise<TResult>,
): Promise<TResult> => {
  const next: Record<string, unknown> = { ...(ctx.payload as unknown as Record<string, unknown>) };
  for (const key of CODEX_UNSUPPORTED_BODY_FIELDS) delete next[key];
  ctx.payload = next as unknown as typeof ctx.payload;
  return await run();
};
