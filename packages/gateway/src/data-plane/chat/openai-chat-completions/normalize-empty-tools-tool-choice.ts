import { normalizeEmptyTools } from '../shared/normalize-empty-tools.ts';

export const normalizeEmptyToolsForOpenAIChatCompletions = normalizeEmptyTools('request.chat.openaiChatCompletions', payload =>
  payload.tool_choice === 'none' ? payload : { ...payload, tool_choice: 'none' });
