import type { FlagDefaults } from '@floway-dev/provider';

// Exhaustive flag defaults for custom (generic OpenAI-compatible) upstreams.
export const CUSTOM_DEFAULT_FLAGS: FlagDefaults = {
  'vendor-deepseek': false,
  'vendor-qwen': false,
  'vendor-kimi': false,
  'retry-cyber-policy': false,
  'messages-web-search-shim': true,
  'responses-web-search-shim': true,
  'responses-image-generation-shim': true,
  // Custom targets are OpenAI-compatible and typically expose a native
  // /responses/compact endpoint (or don't need compaction at all), so the
  // shim stays off by default. Operator can turn it on for a specific
  // upstream that lacks native compact.
  'responses-compact-shim': false,
  'disable-reasoning-on-forced-tool-choice': false,
  'demote-interleaved-system-to-user': false,
  'demote-developer-to-system': false,
  'promote-system-to-developer': false,
  // `x-anthropic-billing-header:` from Claude Code clients is meaningful
  // only to the Anthropic subscription endpoint; strip it here so it
  // does not pollute the OpenAI-compatible upstream's prompt-cache key.
  'strip-billing-attribution': true,
  'strip-prompt-cache-key': false,
};
