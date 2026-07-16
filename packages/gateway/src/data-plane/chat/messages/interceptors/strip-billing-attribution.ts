import type { MessagesPayloadInterceptor } from './types.ts';
import { providerModelOf } from '@floway-dev/provider';

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

export const stripBillingAttribution: MessagesPayloadInterceptor = (ctx, _gatewayCtx, run) => {
  if (!providerModelOf(ctx.candidate).enabledFlags.has('strip-billing-attribution')) return run();

  const { payload } = ctx;

  if (typeof payload.system === 'string') {
    const system = stripText(payload.system);
    const { system: _system, ...rest } = payload;
    ctx.payload = system.length > 0 ? { ...rest, system } : rest;
  } else if (Array.isArray(payload.system)) {
    const system = payload.system
      .map(block => ({ ...block, text: stripText(block.text) }))
      .filter(block => block.text.length > 0);
    const { system: _system, ...rest } = payload;
    ctx.payload = system.length > 0 ? { ...rest, system } : rest;
  }

  return run();
};
