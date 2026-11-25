import { authorizedCall, withoutTransportResponse } from '../authorized-call.ts';
import { defineStage } from './facts.ts';
import { move } from '@floway-dev/pipeline';
import { formatOpenAIResponsesError, isOpenAIResponsesTerminalEvent, parseOpenAIResponsesStream } from '@floway-dev/protocols/openai-responses';
import { parseSseBody } from '@floway-dev/provider';

const output = ['response.http', 'response.modelKey', 'response.openaiResponses'] as const;

export const call = defineStage({
  name: 'chatgpt.call-openai-responses',
  through: {
    request: { needs: ['request.http', 'provider.upstream', 'provider.model'], provides: ['request.http'], consumes: [] },
    response: { needs: ['response.transport'], provides: output, consumes: ['response.transport'] },
  },
  return: { provides: output },
  async execute(facts, scope) {
    const back = await authorizedCall(facts['provider.upstream'], () => facts['request.http'], false, scope,
      request => scope.next({ ...facts, 'request.http': request }), formatOpenAIResponsesError);
    const parsed = 'outcome' in back ? back : await parseSseBody(
      back, scope,
      parseOpenAIResponsesStream, { kind: 'terminalEvent', isTerminal: isOpenAIResponsesTerminalEvent }, formatOpenAIResponsesError,
    );
    return {
      ...withoutTransportResponse(back),
      'response.http': move(parsed.http),
      'response.modelKey': facts['provider.model'].upstreamModelId,
      'response.openaiResponses': move(parsed.outcome),
    };
  },
});
