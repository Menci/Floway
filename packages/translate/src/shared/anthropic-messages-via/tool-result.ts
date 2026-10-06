import type { AnthropicMessagesTextBlockParam, AnthropicMessagesToolResultBlock } from '@floway-dev/protocols/anthropic-messages';

export const flattenAnthropicMessagesToolResult = (content: AnthropicMessagesToolResultBlock['content']): string => {
  if (content === undefined) return '';
  if (typeof content === 'string') {
    return content;
  }

  const textBlocks = content.filter((block): block is AnthropicMessagesTextBlockParam => block.type === 'text');
  if (textBlocks.length === content.length) {
    return textBlocks.map(block => block.text).join('\n\n');
  }

  return JSON.stringify(content);
};
