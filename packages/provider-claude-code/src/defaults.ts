import type { FlagDefaults } from '@floway-dev/provider';

// Exhaustive flag defaults for Claude.ai (Claude Code) subscription
// upstreams.
//
// * Hosted-tool shims stay off — Claude Code's Messages passthrough
//   forwards caller bytes verbatim, so a gateway-side shim would silently
//   rewrite a request the operator deliberately let through unchanged.
// * `responses-compact-shim` defaults on: Anthropic Messages has no
//   /responses/compact concept, and the shim is what synthesizes a
//   `response.compaction` envelope for callers that expect one.
// * `strip-billing-attribution` defaults off: the `x-anthropic-billing-header:`
//   block from Claude Code clients IS the input Anthropic reads to bill
//   the request against the user's subscription. Stripping it here would
//   route billing away from the user's plan.
export const CLAUDE_CODE_DEFAULT_FLAGS: FlagDefaults = {
  'vendor-deepseek': false,
  'vendor-qwen': false,
  'vendor-kimi': false,
  'retry-cyber-policy': false,
  'messages-web-search-shim': false,
  'responses-web-search-shim': false,
  'responses-image-generation-shim': false,
  'responses-compact-shim': true,
  'disable-reasoning-on-forced-tool-choice': false,
  'demote-interleaved-system-to-user': false,
  'demote-developer-to-system': false,
  'promote-system-to-developer': false,
  'strip-billing-attribution': false,
  'strip-prompt-cache-key': false,
};
