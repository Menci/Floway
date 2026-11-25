import { defineCopilotStage } from '../facts.ts';
import { parseJsonObject } from '../shared/json.ts';
import { move, transform } from '@floway-dev/pipeline';
import { formatOpenAIChatCompletionsError } from '@floway-dev/protocols/openai-chat-completions';
import { parseResultBody } from '@floway-dev/provider';

export const parseOpenAIImagesEdits = defineCopilotStage({
  name: 'copilot.openaiImagesEdits.parse',
  through: {
    request: { needs: ['copilot.modelId'], provides: [], consumes: ['copilot.modelId'] },
    response: {
      needs: ['response.transport'],
      provides: ['response.http', 'response.modelKey', 'response.openaiImagesEdits'],
      consumes: ['response.transport'],
    },
  },
  execute: transform(() => {
    let modelKey: string;
    return {
      request({ 'copilot.modelId': id, ...facts }) {
        modelKey = id;
        return facts;
      },
      async response(facts) {
        const { 'response.transport': _transport, ...rest } = facts;
        const { http, outcome } = await parseResultBody(facts, parseJsonObject, formatOpenAIChatCompletionsError);
        return { ...rest, 'response.http': move(http), 'response.modelKey': modelKey, 'response.openaiImagesEdits': move(outcome) };
      },
    };
  }),
});
