import type { AnthropicMessagesPayloadInterceptor } from './types.ts';
import { providerModelOf } from '@floway-dev/provider';

// Claude Code clients seed every Anthropic Messages request with an
// `x-anthropic-billing-header: …` line carrying a per-turn `cch=<hash>` value,
// and with the `claude-code-20250219` `anthropic-beta` flag. Two upstreams
// want opposite things from those markers:
//
//   - The Claude Code subscription endpoint (provider kind `claude-code`)
//     reads them to bill the request against the user's plan tier. If
//     we strip them, the request silently falls off plan billing.
//   - Every other upstream (copilot, azure, custom) bills the request as
//     ordinary API traffic. The system-prompt block is ordinary prompt text
//     there: the `cch=` hash flips per call, so the upstream's prompt-cache
//     layer sees a "different" prompt every turn and never reuses its cache,
//     even when the real conversation prefix hasn't changed. On the official
//     Anthropic API with an API key, the markers also classify the request
//     as Claude Code usage, which the monthly API credits bundled with
//     Max/Team plans do not cover, so a credits-only organization answers
//     "Your credit balance is too low" although the same request without
//     the markers succeeds.
//     https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers#what-the-credits-cover
//
// Gating is owned by the `strip-billing-attribution` flag in the provider
// flag catalog; defaults are wired there per kind.
const BILLING_HEADER_LINE_RE = /x-anthropic-billing-header[^\n]*/g;
const CCH_HASH_RE = /cch=[0-9a-f]{5,};?/gi;
// https://github.com/decolua/9router/issues/4739
const CLAUDE_CODE_BETA = 'claude-code-20250219';

const stripText = (text: string): string => text.replace(BILLING_HEADER_LINE_RE, '').replace(CCH_HASH_RE, '').trim();

export const stripBillingAttribution: AnthropicMessagesPayloadInterceptor = (ctx, _gatewayCtx, run) => {
  if (!providerModelOf(ctx.candidate).enabledFlags.has('strip-billing-attribution')) return run();

  ctx.anthropicBeta = ctx.anthropicBeta.filter(beta => beta !== CLAUDE_CODE_BETA);

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
