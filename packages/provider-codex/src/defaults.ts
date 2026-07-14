import type { FlagDefaults } from '@floway-dev/provider';

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
  // Codex's Responses Lite wire carries base instructions as leading developer
  // messages. Use the same representation for system-role input.
  // https://github.com/openai/codex/blob/1f17e7512f0e47625f2cad416f14870688a99814/codex-rs/core/src/client.rs#L829-L849
  'promote-system-to-developer': true,
  'strip-billing-attribution': true,
  'strip-prompt-cache-key': false,
};
