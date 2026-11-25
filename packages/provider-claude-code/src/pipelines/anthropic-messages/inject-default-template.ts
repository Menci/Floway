import { defineStage } from './facts.ts';
import { DEFAULT_TEMPLATE_BLOCK } from './system-blocks.ts';
import { move, transform } from '@floway-dev/pipeline';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';

export const injectDefaultTemplate = defineStage({
  name: 'claude-code.inject-default-template',
  through: {
    request: {
      needs: ['request.anthropicMessages', 'request.claudeCodeShaped'],
      provides: ['request.anthropicMessages'],
      consumes: [],
    },
    response: { needs: [], provides: [], consumes: [] },
  },
  execute: transform(() => ({
    request: facts => facts['request.claudeCodeShaped'] ? facts : {
      ...facts,
      'request.anthropicMessages': move(addDefaultTemplate(facts['request.anthropicMessages'])),
    },
  })),
});

// The four-breakpoint budget is shared by tools, system blocks, and messages.
// https://platform.claude.com/docs/en/build-with-claude/prompt-caching
const CACHE_BREAKPOINT_CAP = 4;

export const addDefaultTemplate = (payload: AnthropicMessagesPayload): AnthropicMessagesPayload => {
  if (!Array.isArray(payload.system)) throw new TypeError('Expected Claude Code system blocks before the default template');
  const { system, tools = [], messages } = payload;
  const blocks = [...system, ...tools, ...messages.flatMap(message => typeof message.content === 'string' ? [] : message.content)];
  const breakpoints = blocks.filter(block => 'cache_control' in block && block.cache_control).length;
  const { cache_control: _cacheControl, ...uncachedTemplate } = DEFAULT_TEMPLATE_BLOCK;
  const template = breakpoints >= CACHE_BREAKPOINT_CAP ? uncachedTemplate : DEFAULT_TEMPLATE_BLOCK;
  return { ...payload, system: [...system, template] };
};
