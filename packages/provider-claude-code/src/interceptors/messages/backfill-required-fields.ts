import type { MessagesBoundaryCtx } from './types.ts';
import { MESSAGES_FALLBACK_MAX_TOKENS } from '@floway-dev/protocols/messages';

// Real Claude Code always sends `max_tokens` and `temperature` on every
// request body. Anthropic's `/v1/messages` requires `max_tokens` and 422s
// without it; `temperature` is technically optional upstream, but its
// absence is a CC-shape fingerprint failure that the plan-billing detector
// keys on. Third-party callers (cline, aider, custom integrations) routinely
// omit one or both, expecting the gateway to backfill.
//
// Sub2api (`backend/internal/service/gateway_service.go:1301-1314`,
// rev 4a5665da5b2c6b83c4597844ea6e573746c821b1) unconditionally backfills
// both: `max_tokens` to 128000 and `temperature` to 1. We mirror the same
// unconditional fill but cap `max_tokens` to the model's advertised output
// limit when present (`limits.max_output_tokens`), falling back to the
// gateway-wide MESSAGES_FALLBACK_MAX_TOKENS (8192) — sub2api's hardcoded
// 128000 ignores per-model output caps which we don't want to reproduce.
//
// Positioned at the head of the chain so the rest of the re-mimicry steps
// see a fully-formed payload. Caller-supplied values are never overwritten.
export const backfillRequiredFields = async <TResult>(
  ctx: MessagesBoundaryCtx,
  _env: object,
  run: () => Promise<TResult>,
): Promise<TResult> => {
  const next = { ...ctx.payload };

  next.max_tokens ??= ctx.model.limits.max_output_tokens ?? MESSAGES_FALLBACK_MAX_TOKENS;
  next.temperature ??= 1;

  ctx.payload = next;
  return await run();
};
