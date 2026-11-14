import { normalizeEmptyTools } from '../shared/normalize-empty-tools.ts';
import { collectOpenAIResponsesTools, type CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';

export const normalizeEmptyToolsForOpenAIResponses = normalizeEmptyTools('request.chat.openaiResponses', payload =>
  payload.tool_choice === 'none' || collectOpenAIResponsesTools(payload as CanonicalOpenAIResponsesPayload).length > 0 ? payload : { ...payload, tool_choice: 'none' });
