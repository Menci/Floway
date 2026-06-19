// Anthropic's prompt cache is opt-in: a request with no cache_control
// breakpoint anywhere returns cache_read_input_tokens=0 regardless of how
// stable the prompt prefix is. Source APIs without an explicit cache_control
// concept — Codex on the Responses wire (opaque prompt_cache_key) and plain
// Chat Completions (no caching field) — silently drop the field through
// translation, so every codex-through-messages or chat-through-messages turn
// is a cache miss while native Messages clients hit cache fine because they
// inject breakpoints themselves.
//
// Place breakpoints in the translated payload. Up to 4 are allowed per
// request; we use 3 and leave one for downstream additions:
//
// - system block when system text is non-empty
// - last function-tool definition (caches the system+tools prefix, the most
//   stable per-turn chunk)
// - last cacheable block of the latest message that has one (caches
//   conversation history through the latest turn so subsequent turns build on
//   a longer cached prefix)
//
// Reference:
// - https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching

import type {
  MessagesAssistantContentBlock,
  MessagesImageBlock,
  MessagesMessage,
  MessagesTextBlock,
  MessagesTool,
  MessagesToolResultBlock,
  MessagesToolUseBlock,
  MessagesUserContentBlock,
} from '@floway-dev/protocols/messages';

export const EPHEMERAL_CACHE_CONTROL = { type: 'ephemeral' } as const;

export const applyLastToolCacheBreakpoint = (tools: MessagesTool[] | undefined): void => {
  if (!tools || tools.length === 0) return;
  for (let i = tools.length - 1; i >= 0; i--) {
    const tool = tools[i];
    // Native web-search tools carry a `web_search_*` discriminant and are not
    // part of the stable prefix, so the breakpoint lands on the last custom
    // tool instead.
    if (!tool.type || tool.type === 'custom') {
      tool.cache_control = EPHEMERAL_CACHE_CONTROL;
      return;
    }
  }
};

type CacheableContentBlock = MessagesTextBlock | MessagesImageBlock | MessagesToolUseBlock | MessagesToolResultBlock;

const isCacheableBlock = (block: MessagesUserContentBlock | MessagesAssistantContentBlock): block is CacheableContentBlock =>
  block.type === 'text' || block.type === 'image' || block.type === 'tool_use' || block.type === 'tool_result';

export const applyLastMessageCacheBreakpoint = (messages: MessagesMessage[]): void => {
  for (let m = messages.length - 1; m >= 0; m--) {
    const message = messages[m];

    if (typeof message.content === 'string') {
      // MessagesTextBlock is valid in the user, assistant, and system content
      // unions, so the union cast lets one literal serve any of the three roles.
      const block: MessagesTextBlock = { type: 'text', text: message.content, cache_control: EPHEMERAL_CACHE_CONTROL };
      message.content = [block] as MessagesUserContentBlock[] | MessagesAssistantContentBlock[] | MessagesTextBlock[];
      return;
    }

    for (let b = message.content.length - 1; b >= 0; b--) {
      const block = message.content[b];
      if (isCacheableBlock(block)) {
        block.cache_control = EPHEMERAL_CACHE_CONTROL;
        return;
      }
    }
  }
};
