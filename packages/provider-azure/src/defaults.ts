import type { FlagDefaults } from '@floway-dev/provider';

export const AZURE_DEFAULT_FLAGS: FlagDefaults = {
  'vendor-deepseek': false,
  'vendor-qwen': false,
  'vendor-kimi': false,
  'retry-cyber-policy': false,
  'messages-web-search-shim': true,
  'responses-web-search-shim': true,
  'responses-image-generation-shim': true,
  // Azure exposes native /responses/compact.
  'responses-compact-shim': false,
  'disable-reasoning-on-forced-tool-choice': false,
  'demote-interleaved-system-to-user': false,
  'demote-developer-to-system': false,
  'promote-system-to-developer': false,
  'strip-billing-attribution': true,
  'strip-prompt-cache-key': false,
};
