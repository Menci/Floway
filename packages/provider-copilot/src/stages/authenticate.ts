import { getCopilotToken, isCopilotTokenFetchError, type CopilotAuth } from '../auth.ts';
import { rawModelFor } from '../operation-model.ts';
import type { EmbeddingsRequest, CopilotRequest } from '../pipeline-facts.ts';
import { takeHttpResponse } from '@floway-dev/http/pipeline';
import { defineStage, move, secret, type Handed } from '@floway-dev/pipeline';
import type { ProviderResponse, ProviderServices } from '@floway-dev/provider';

export const authenticateCopilot = (auth: CopilotAuth) => {
  const authenticate = defineStage<EmbeddingsRequest, CopilotRequest, ProviderResponse, ProviderResponse, ProviderResponse, ProviderServices>({
    name: 'authenticateCopilot',
    through: {
      request: {
        needs: ['request.provider.model', 'request.http.callId'],
        consumes: [],
        provides: ['request.copilot.session'],
      },
      response: { needs: ['response.http.exchange', 'response.provider.modelKey', 'response.provider.called'], consumes: [], provides: [] },
    },
    return: { provides: ['response.http.exchange', 'response.http.body', 'response.provider.modelKey', 'response.provider.called', 'response.provider.previousCalls'] },
    execute: async (facts, next, use) => {
      const call = use.httpCall(facts['request.http.callId']);
      let entry;
      try {
        entry = await getCopilotToken(auth.id, auth.githubHost, auth.githubToken, call.fetcher, call.signal);
      } catch (error) {
        if (!isCopilotTokenFetchError(error)) throw error;
        const exchange = takeHttpResponse(new Response(error.body, { status: error.status, headers: error.headers }));
        return move({
          ...facts,
          'response.http.exchange': exchange,
          'response.http.body': exchange.body,
          'response.provider.modelKey': rawModelFor(facts['request.provider.model'], 'openaiEmbeddings').id,
          'response.provider.called': false,
          'response.provider.previousCalls': [],
        });
      }
      return await next(move({ ...facts, 'request.copilot.session': { ...entry, token: secret(entry.token) } })) as Handed<ProviderResponse>;
    },
  });
  return authenticate;
};
