import type { FlagDefaults } from '@floway-dev/provider';

// Exhaustive flag defaults for ChatGPT Codex (subscription) upstreams.
// Codex has no hosted-tool concept, so the three shim flags stay off.
export const CODEX_DEFAULT_FLAGS: FlagDefaults = {
  'vendor-deepseek': false,
  'vendor-qwen': false,
  'vendor-kimi': false,
  'retry-cyber-policy': false,
  'messages-web-search-shim': false,
  'responses-web-search-shim': false,
  'responses-image-generation-shim': false,
  'responses-compact-shim': false,
  'disable-reasoning-on-forced-tool-choice': false,
  'demote-interleaved-system-to-user': false,
  'demote-developer-to-system': false,
  'strip-billing-attribution': true,
};
