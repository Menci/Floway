import type { FlagDefaults } from '@floway-dev/provider';

export const KIMI_CODE_DEFAULT_FLAGS: FlagDefaults = {
  'vendor-deepseek': false,
  'vendor-qwen': false,
  'vendor-kimi': true,
  'anthropic-messages-web-search-shim': true,
  'openai-responses-web-search-shim': true,
  'openai-responses-image-generation-shim': true,
  'openai-responses-compact-shim': true,
  'openai-responses-compact-decrypt': false,
  'openai-responses-collaboration-shim': true,
  // The Responses endpoint rejects an `agent_message` input item outright
  // ("input.0: item type \"agent_message\" is not supported"), so a Codex
  // sub-agent task never reaches the model without the lowering.
  // https://github.com/openai/codex/blob/0a2eb4696c26ac33204bcd255721ab30220a4774/codex-rs/protocol/src/models.rs#L1036-L1046
  'openai-responses-agent-message-shim': true,
  'serialize-stream-items': false,
  'disable-reasoning-on-forced-tool-choice': false,
  'empty-tools-tool-choice-none': false,
  'rewrite-mid-conv-system-to-user': false,
  'rewrite-disallowed-mid-conv-system-to-user': false,
  'rewrite-developer-to-system': false,
  'rewrite-system-to-developer': false,
  'strip-billing-attribution': true,
  'strip-prompt-cache-key': false,
  'usage-exclusive-cached-tokens': false,
  'openai-responses-store-false': false,
};
