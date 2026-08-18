import type { AnthropicMessagesTextBlock, AnthropicMessagesToolResultBlock } from '@floway-dev/protocols/anthropic-messages';

export const flattenAnthropicMessagesToolResult = (content: AnthropicMessagesToolResultBlock['content']): string => {
  if (typeof content === 'string') {
    return content;
  }

  const textBlocks = content.filter((block): block is AnthropicMessagesTextBlock => block.type === 'text');
  if (textBlocks.length === content.length) {
    return textBlocks.map(block => block.text).join('\n\n');
  }

  return JSON.stringify(content);
};
