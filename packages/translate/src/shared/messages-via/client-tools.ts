import type { MessagesClientTool, MessagesPayload } from '@floway-dev/protocols/messages';

export const filterMessagesClientTools = (tools: MessagesPayload['tools'] | undefined): MessagesClientTool[] | undefined => {
  const clientTools = tools?.filter((tool): tool is MessagesClientTool => tool.type === undefined || tool.type === 'custom');
  return clientTools?.length ? clientTools : undefined;
};
