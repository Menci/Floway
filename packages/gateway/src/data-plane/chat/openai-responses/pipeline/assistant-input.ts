import { defineStage } from '../../pipeline/facts.ts';
import { normalizeAssistantInputText } from '../items/normalize-assistant-content.ts';

export const normalizeOpenAIResponsesAssistantInput = defineStage({
  name: 'openaiResponses.normalize-assistant-input',
  through: {
    request: { needs: ['openaiResponses'], provides: ['openaiResponses'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const payload = facts.openaiResponses;
    const input = normalizeAssistantInputText(payload.input);
    if (input === payload.input) return await scope.next(facts);
    return await scope.next({ ...facts, openaiResponses: { ...payload, input } });
  },
});
