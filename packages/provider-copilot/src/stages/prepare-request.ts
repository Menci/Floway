import { copilotRequestHeaders } from '../auth.ts';
import { copilotOpenAIEmbeddingsBody, rawModelFor } from '../operation-model.ts';
import type { CopilotRequest, CopilotHttpFacts } from '../pipeline-facts.ts';
import type { HttpResponseFacts } from '@floway-dev/http/pipeline';
import { defineStage, isSecret, move, secret, type Secret } from '@floway-dev/pipeline';
import type { ProviderResponse, ProviderServices } from '@floway-dev/provider';

export const prepareCopilotEmbeddings = () => {
  const prepare = defineStage<CopilotRequest, CopilotHttpFacts, HttpResponseFacts, ProviderResponse, ProviderServices>({
    name: 'prepareCopilotOpenAIEmbeddings',
    through: {
      request: {
        needs: ['request.provider.model', 'request.provider.payload', 'request.http.headers', 'request.http.callId', 'request.copilot.session'],
        consumes: ['request.provider.model', 'request.provider.payload', 'request.copilot.session', 'request.http.headers'],
        provides: ['request.http.url', 'request.http.method', 'request.http.headers', 'request.http.body', 'request.http.encoding', 'request.copilot.modelKey'],
      },
      response: { needs: ['response.http.exchange'], consumes: [], provides: ['response.provider.modelKey', 'response.provider.called', 'response.provider.previousCalls'] },
    },
    execute: async (facts, next) => {
      const { 'request.provider.model': model, 'request.provider.payload': payload, 'request.copilot.session': session, ...rest } = facts;
      const modelKey = rawModelFor(model, 'openaiEmbeddings').id;
      const admitted = facts['request.http.headers'].map(([name, value]): [string, string] => [name, isSecret(value) ? value.reveal() : value]);
      const headers = [...copilotRequestHeaders({ ...session, token: session.token.reveal() }, undefined, admitted)]
        .map(([name, value]): [string, string | Secret<string>] => [name, name === 'authorization' ? secret(value) : value]);
      const back = await next(move({
        ...rest,
        'request.copilot.modelKey': modelKey,
        'request.http.url': `${session.baseUrl}/embeddings`,
        'request.http.method': 'POST',
        'request.http.headers': headers,
        'request.http.body': { ...copilotOpenAIEmbeddingsBody(payload), model: modelKey },
        'request.http.encoding': 'json' as const,
      }));
      return move({ ...back, 'response.provider.modelKey': modelKey, 'response.provider.called': back['response.http.exchange'].type === 'response', 'response.provider.previousCalls': [] });
    },
  });
  return prepare;
};
