import { responsesPayloadStage } from './facts.ts';
import { collectOpenAIResponsesTools } from '@floway-dev/protocols/openai-responses';

export const normalizeEmptyToolsToolChoice = responsesPayloadStage('normalizeEmptyToolsToolChoice', (payload, facts) => {
  if (!facts['route.candidate'].providerModel.enabledFlags.includes('empty-tools-tool-choice-none')) return payload;
  if (!Array.isArray(payload.tools) || payload.tools.length !== 0 || collectOpenAIResponsesTools(payload).length !== 0) return payload;
  return { ...payload, tool_choice: 'none' };
});
