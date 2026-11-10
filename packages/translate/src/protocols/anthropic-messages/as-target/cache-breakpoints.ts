// Anthropic's prompt cache is opt-in: a request with no cache_control
// breakpoint anywhere reports no cache reads regardless of how stable its
// prefix is. A client of this wire injects its own breakpoints; a request
// written from the input IR carries none, so it would never cache. The IR's
// `prompt_cache_key` is a different mechanism and does not travel here.
//
// Place breakpoints in the written payload. Up to 4 are allowed per request;
// we use 3 and leave one for downstream additions:
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
  AnthropicMessagesCacheControl,
  AnthropicMessagesMessage,
  AnthropicMessagesTextBlockParam,
  AnthropicMessagesTool,
} from '@floway-dev/protocols/anthropic-messages';

const ephemeralCacheControl = (): AnthropicMessagesCacheControl => ({ type: 'ephemeral' });

export const applyLastToolCacheBreakpoint = (tools: AnthropicMessagesTool[] | undefined): void => {
  if (!tools || tools.length === 0) return;
  for (let i = tools.length - 1; i >= 0; i--) {
    const tool = tools[i];
    // Native web-search tools carry a `web_search_*` discriminant and are not
    // part of the stable prefix, so the breakpoint lands on the last custom
    // tool instead.
    if (!tool.type || tool.type === 'custom') {
      tool.cache_control = ephemeralCacheControl();
      return;
    }
  }
};

export const applyLastSystemCacheBreakpoint = (system: AnthropicMessagesTextBlockParam[] | undefined): void => {
  if (!system || system.length === 0) return;
  system[system.length - 1].cache_control = ephemeralCacheControl();
};

export const applyLastMessageCacheBreakpoint = (messages: AnthropicMessagesMessage[]): void => {
  for (let m = messages.length - 1; m >= 0; m--) {
    const message = messages[m];

    if (typeof message.content === 'string') {
      const block: AnthropicMessagesTextBlockParam = { type: 'text', text: message.content, cache_control: ephemeralCacheControl() };
      message.content = [block];
      return;
    }

    for (let b = message.content.length - 1; b >= 0; b--) {
      const block = message.content[b];
      if (block.type === 'text' || block.type === 'image' || block.type === 'tool_use' || block.type === 'tool_result') {
        block.cache_control = ephemeralCacheControl();
        return;
      }
    }
  }
};
