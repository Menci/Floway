import { defineCopilotStage } from '../facts.ts';
import { move, transform } from '@floway-dev/pipeline';
import { formatOpenAIResponsesError, parseOpenAIResponsesStream, isOpenAIResponsesTerminalEvent } from '@floway-dev/protocols/openai-responses';
import { parseSseBody } from '@floway-dev/provider';

export const parseOpenAIResponses = defineCopilotStage({
  name: 'copilot.openaiResponses.parse',
  through: {
    request: { needs: ['copilot.modelId'], provides: [], consumes: ['copilot.modelId'] },
    response: {
      needs: ['response.transport'],
      provides: ['response.http', 'response.modelKey', 'response.openaiResponses'],
      consumes: ['response.transport'],
    },
  },
  execute: transform(scope => {
    let modelKey: string;
    return {
      request({ 'copilot.modelId': id, ...facts }) {
        modelKey = id;
        return facts;
      },
      async response(facts) {
        const { 'response.transport': _transport, ...rest } = facts;
        const { http, outcome } = await parseSseBody(facts, scope, parseOpenAIResponsesStream, { kind: 'terminalEvent', isTerminal: event => event.type === 'error' || isOpenAIResponsesTerminalEvent(event) }, formatOpenAIResponsesError);
        return { ...rest, 'response.http': move(http), 'response.modelKey': modelKey, 'response.openaiResponses': move(outcome) };
      },
    };
  }),
});
