import { normalizeEmptyTools } from '../shared/normalize-empty-tools.ts';

export const normalizeEmptyToolsForAnthropicMessages = normalizeEmptyTools('request.chat.anthropicMessages', payload =>
  payload.tool_choice?.type === 'none' ? payload : { ...payload, tool_choice: { type: 'none' } });
