import type { MessagesInterceptor } from './types.ts';

// Claude Code clients seed every Messages request with an
// `x-anthropic-billing-header: …` line carrying a per-turn `cch=<hash>` value.
// Two upstreams want opposite things from that block:
//
//   - The Claude Code subscription endpoint (provider kind `claude-code`)
//     reads the block to bill the request against the user's plan tier. If
//     we strip it, the request silently falls off plan billing.
//   - Every other upstream (copilot, azure, custom) treats the block as
//     ordinary prompt text. The `cch=` hash flips per call, so the
//     upstream's prompt-cache layer sees a "different" prompt every turn
//     and never reuses its cache, even when the real conversation prefix
//     hasn't changed.
//
// Gating is owned by the `strip-billing-attribution` flag in the provider
// flag catalog; defaults are wired there per kind.
const BILLING_HEADER_LINE_RE = /x-anthropic-billing-header[^\n]*/g;
const CCH_HASH_RE = /cch=[0-9a-f]{5,};?/gi;

const stripText = (text: string): string => text.replace(BILLING_HEADER_LINE_RE, '').replace(CCH_HASH_RE, '').trim();

export const stripBillingAttribution: MessagesInterceptor = (ctx, _gatewayCtx, run) => {
  if (!ctx.candidate.model.enabledFlags.has('strip-billing-attribution')) return run();

  const { payload } = ctx;

  if (typeof payload.system === 'string') {
    payload.system = stripText(payload.system);
    if (!payload.system) delete payload.system;
  } else if (Array.isArray(payload.system)) {
    for (const block of payload.system) {
      block.text = stripText(block.text);
    }
    payload.system = payload.system.filter(block => block.text.length > 0);
    if (payload.system.length === 0) delete payload.system;
  }

  return run();
};
