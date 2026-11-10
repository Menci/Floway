import type { AnthropicMessagesClientTool, AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';

export const filterAnthropicMessagesClientTools = (tools: AnthropicMessagesPayload['tools'] | undefined): AnthropicMessagesClientTool[] | undefined => {
  const clientTools = tools?.filter((tool): tool is AnthropicMessagesClientTool => tool.type === undefined || tool.type === 'custom');
  return clientTools?.length ? clientTools : undefined;
};
