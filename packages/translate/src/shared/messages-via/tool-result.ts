import type { MessagesTextBlock, MessagesToolResultBlock } from '@floway-dev/protocols/messages';

export const flattenMessagesToolResult = (content: MessagesToolResultBlock['content']): string => {
  if (typeof content === 'string') {
    return content;
  }

  const textBlocks = content.filter((block): block is MessagesTextBlock => block.type === 'text');
  if (textBlocks.length === content.length) {
    return textBlocks.map(block => block.text).join('\n\n');
  }

  return JSON.stringify(content);
};
