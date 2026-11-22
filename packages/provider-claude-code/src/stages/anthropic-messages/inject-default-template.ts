import { DEFAULT_TEMPLATE_BLOCK } from './system-blocks.ts';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';

type MessagePayload = Omit<AnthropicMessagesPayload, 'model'>;

// Anthropic caps requests at four prompt-cache breakpoints shared across
// tools, system blocks, and message content.
// https://platform.claude.com/docs/en/build-with-claude/prompt-caching
const ANTHROPIC_CACHE_BREAKPOINT_CAP = 4;

const countCacheBreakpoints = (payload: Pick<AnthropicMessagesPayload, 'tools' | 'system' | 'messages'>): number => {
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

// The template occupies `system[2]`. When the caller already holds four
// breakpoints, we keep the template text and omit our cache control so the
// request stays within the upstream cap.
export const injectDefaultTemplatePayload = <P extends MessagePayload>(payload: P): P => {
  if (!Array.isArray(payload.system)) {
    throw new Error('injectDefaultTemplatePayload requires the billing stage to create the system array');
  }
  const callerBreakpoints = countCacheBreakpoints(payload);
  const templateBlock = callerBreakpoints >= ANTHROPIC_CACHE_BREAKPOINT_CAP
    ? { type: 'text' as const, text: DEFAULT_TEMPLATE_BLOCK.text }
    : DEFAULT_TEMPLATE_BLOCK;
  return { ...payload, system: [...payload.system, templateBlock] };
};
