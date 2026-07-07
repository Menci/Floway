import type { FlagDefaults } from '@floway-dev/provider';

// Exhaustive flag defaults for Ollama upstreams (self-hosted daemon or ollama.com).
export const OLLAMA_DEFAULT_FLAGS: FlagDefaults = {
  'vendor-deepseek': false,
  'vendor-qwen': false,
  'vendor-kimi': false,
  'retry-cyber-policy': false,
  'messages-web-search-shim': true,
  'responses-web-search-shim': true,
  'responses-image-generation-shim': true,
  // Ollama exposes no native /responses/compact, so the shim stays on.
  'responses-compact-shim': true,
  'disable-reasoning-on-forced-tool-choice': false,
  'demote-interleaved-system-to-user': false,
  'demote-developer-to-system': false,
  'strip-billing-attribution': true,
};
