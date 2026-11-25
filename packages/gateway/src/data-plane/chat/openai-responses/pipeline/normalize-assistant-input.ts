import { gatewayFactSpace } from '../../../pipeline/facts.ts';
import { normalizeAssistantInputText } from '../items/normalize-assistant-content.ts';
import { move, transform } from '@floway-dev/pipeline';

const { defineStage } = gatewayFactSpace<{}>();

// Copilot and Azure compacted histories can replay assistant input_text as
// input, but those same endpoints require output_text on assistant messages.
export const normalizeOpenAIResponsesAssistantInput = defineStage({
  name: 'openaiResponses.normalize-assistant-input',
  through: {
    request: { needs: ['request.openaiResponses'], provides: ['request.openaiResponses'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  execute: transform(() => ({
    request(facts) {
      const payload = facts['request.openaiResponses'];
      return { ...facts, 'request.openaiResponses': move({ ...payload, input: normalizeAssistantInputText(payload.input) }) };
    },
  })),
});
