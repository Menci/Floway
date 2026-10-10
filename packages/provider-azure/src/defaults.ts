import type { FlagDefaults } from '@floway-dev/provider';

export const AZURE_DEFAULT_FLAGS: FlagDefaults = {
  'vendor-deepseek': false,
  'vendor-qwen': false,
  'vendor-kimi': false,
  'anthropic-messages-web-search-shim': true,
  'openai-responses-web-search-shim': true,
  'openai-responses-image-generation-shim': true,
  'openai-responses-compact-shim': true,
  'openai-responses-compact-decrypt': false,
  'openai-responses-collaboration-shim': true,
  'openai-responses-agent-message-shim': false,
  'serialize-stream-items': false,
  'disable-reasoning-on-forced-tool-choice': false,
  'empty-tools-tool-choice-none': false,
  'rewrite-mid-conv-system-to-user': false,
  'rewrite-developer-to-system': false,
  'rewrite-system-to-developer': false,
  'strip-billing-attribution': true,
  'strip-prompt-cache-key': false,
  'usage-exclusive-cached-tokens': false,
  // Default off: stateless upstream mode is opt-in. Copilot's provider is
  // the exception — see provider-copilot's defaults.
  'openai-responses-store-false': false,
};
