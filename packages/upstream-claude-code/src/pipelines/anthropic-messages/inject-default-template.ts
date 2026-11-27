import { defineStage } from './facts.ts';
import { DEFAULT_TEMPLATE_BLOCK } from './system-blocks.ts';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';

// Anthropic counts cache breakpoints across the system, tools and messages.
// https://platform.claude.com/docs/en/build-with-claude/prompt-caching
const ANTHROPIC_CACHE_BREAKPOINT_CAP = 4;

const countCacheBreakpoints = (payload: AnthropicMessagesPayload): number => {
  let count = 0;
  if (payload.tools) {
    for (const tool of payload.tools) {
      if ('cache_control' in tool && tool.cache_control) count++;
    }
  }
  if (Array.isArray(payload.system)) {
    for (const block of payload.system) {
      if (block.cache_control) count++;
    }
  }
  for (const message of payload.messages) {
    if (typeof message.content === 'string') continue;
    for (const block of message.content) {
      if ('cache_control' in block && block.cache_control) count++;
    }
  }
  return count;
};

export const injectDefaultTemplate = defineStage({
  name: 'claude-code.anthropic-messages.inject-default-template',
  through: {
    request: { needs: ['anthropicMessages', 'claudeCode.shaped'], provides: ['anthropicMessages'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    if (facts['claudeCode.shaped']) return await scope.next(facts);
    const payload = facts.anthropicMessages;
    if (!Array.isArray(payload.system)) throw new TypeError('Claude Code template requires a system block array');
    // Keep the CLI template text when callers already used every breakpoint.
    const block = countCacheBreakpoints(payload) >= ANTHROPIC_CACHE_BREAKPOINT_CAP
      ? { type: 'text' as const, text: DEFAULT_TEMPLATE_BLOCK.text }
      : DEFAULT_TEMPLATE_BLOCK;
    return await scope.next({ ...facts, anthropicMessages: { ...payload, system: [...payload.system, block] } });
  },
});
