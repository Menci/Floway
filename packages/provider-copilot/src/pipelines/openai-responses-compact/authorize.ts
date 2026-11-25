import { defineCopilotStage } from '../facts.ts';
import { authorizeRequest, parseCredentialFailure } from '../shared/authorize.ts';
import { move } from '@floway-dev/pipeline';
import { formatOpenAIResponsesError } from '@floway-dev/protocols/openai-responses';

export const authorizeOpenAIResponsesCompact = defineCopilotStage({
  name: 'copilot.openaiResponsesCompact.authorize',
  through: {
    request: { needs: ['request.http', 'provider.upstream'], provides: ['request.http'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  return: { provides: ['response.http', 'response.openaiResponses'] },
  async execute(facts, scope) {
    const upstream = facts['provider.upstream'];
    const credentials = await scope.services.copilot.credentials(upstream, scope.services.fetcher(upstream.id));
    if (!credentials.ok) {
      const { http, outcome } = await parseCredentialFailure(credentials.error, formatOpenAIResponsesError);
      return { 'response.http': move(http), 'response.openaiResponses': move(outcome) };
    }

    return await scope.next({
      ...facts,
      'request.http': authorizeRequest(facts['request.http'], credentials.value),
    });
  },
});
