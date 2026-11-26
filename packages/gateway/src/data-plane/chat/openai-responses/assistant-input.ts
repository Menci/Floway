import { normalizeAssistantInputText } from './items/normalize-assistant-content.ts';
import { defineStage } from '../../pipeline/facts.ts';

// Some Responses compaction backends emit assistant input_text blocks that
// their generation endpoint rejects when the client replays the output.
export const normalizeOpenAIResponsesAssistantInput = defineStage({
  name: 'openaiResponses.normalize-assistant-input',
  through: {
    request: { needs: ['request.openaiResponses'], provides: ['request.openaiResponses'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const payload = facts['request.openaiResponses'];
    const input = normalizeAssistantInputText(payload.input);
    return await scope.next({
      ...facts,
      'request.openaiResponses': input === payload.input ? payload : { ...payload, input },
    });
  },
});
