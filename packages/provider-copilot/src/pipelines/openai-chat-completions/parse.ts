import { defineCopilotStage } from '../facts.ts';
import { move, transform } from '@floway-dev/pipeline';
import { formatOpenAIChatCompletionsError, parseOpenAIChatCompletionsStream } from '@floway-dev/protocols/openai-chat-completions';
import { parseSseBody } from '@floway-dev/provider';

export const parseOpenAIChatCompletions = defineCopilotStage({
  name: 'copilot.openaiChatCompletions.parse',
  through: {
    request: { needs: ['copilot.modelId'], provides: [], consumes: ['copilot.modelId'] },
    response: {
      needs: ['response.transport'],
      provides: ['response.http', 'response.modelKey', 'response.openaiChatCompletions'],
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
        const { http, outcome } = await parseSseBody(facts, scope, parseOpenAIChatCompletionsStream, { kind: 'complete' }, formatOpenAIChatCompletionsError);
        return { ...rest, 'response.http': move(http), 'response.modelKey': modelKey, 'response.openaiChatCompletions': move(outcome) };
      },
    };
  }),
});
