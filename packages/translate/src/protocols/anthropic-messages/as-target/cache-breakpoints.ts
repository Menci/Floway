// Translated Messages requests add up to three cache breakpoints: system text, the last custom tool,
// and the latest cacheable message block. Leave the fourth allowed slot for downstream additions.
// Prompt-cache keys are a separate mechanism.
// https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching

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
