import { defineCopilotStage } from '../facts.ts';
import { parseJsonObject } from '../shared/json.ts';
import { move, transform } from '@floway-dev/pipeline';
import { formatOpenAIChatCompletionsError } from '@floway-dev/protocols/openai-chat-completions';
import { isOpenAIImagesTerminalEvent, openAIImagesStreamRequested, parseOpenAIImagesStream } from '@floway-dev/protocols/openai-images';
import { parseResultBody, parseSseBody } from '@floway-dev/provider';

export const parseOpenAIImagesGenerations = defineCopilotStage({
  name: 'copilot.openaiImagesGenerations.parse',
  through: {
    request: { needs: ['copilot.modelId', 'request.openaiImagesGenerations'], provides: [], consumes: ['copilot.modelId'] },
    response: {
      needs: ['response.transport'],
      provides: ['response.http', 'response.modelKey', 'response.openaiImagesGenerations'],
      consumes: ['response.transport'],
    },
  },
  execute: transform(scope => {
    let modelKey: string;
    let stream: boolean;
    return {
      request({ 'copilot.modelId': id, ...facts }) {
        modelKey = id;
        stream = openAIImagesStreamRequested(facts['request.openaiImagesGenerations'].stream);
        return facts;
      },
      async response(facts) {
        const { 'response.transport': _transport, ...rest } = facts;
        const { http, outcome } = stream
          ? await parseSseBody(facts, scope, parseOpenAIImagesStream, { kind: 'terminalEvent' as const, isTerminal: isOpenAIImagesTerminalEvent }, formatOpenAIChatCompletionsError)
          : await parseResultBody(facts, parseJsonObject, formatOpenAIChatCompletionsError);
        return { ...rest, 'response.http': move(http), 'response.modelKey': modelKey, 'response.openaiImagesGenerations': move(outcome) };
      },
    };
  }),
});
