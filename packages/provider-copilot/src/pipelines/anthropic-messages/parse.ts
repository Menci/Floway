import { defineCopilotStage } from '../facts.ts';
import { move, transform } from '@floway-dev/pipeline';
import { formatAnthropicMessagesError, parseAnthropicMessagesStream } from '@floway-dev/protocols/anthropic-messages';
import { parseSseBody } from '@floway-dev/provider';

export const parseAnthropicMessages = defineCopilotStage({
  name: 'copilot.anthropicMessages.parse',
  through: {
    request: { needs: ['copilot.modelId'], provides: [], consumes: ['copilot.modelId'] },
    response: {
      needs: ['response.transport'],
      provides: ['response.http', 'response.modelKey', 'response.anthropicMessages'],
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
        const { http, outcome } = await parseSseBody(facts, scope, parseAnthropicMessagesStream, { kind: 'terminalEvent', isTerminal: event => event.type === 'message_stop' || event.type === 'error' }, formatAnthropicMessagesError);
        return { ...rest, 'response.http': move(http), 'response.modelKey': modelKey, 'response.anthropicMessages': move(outcome) };
      },
    };
  }),
});
