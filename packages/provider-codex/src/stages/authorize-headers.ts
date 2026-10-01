import type { CodexHttpFacts } from '../pipeline-facts.ts';
import type { HttpResponseFacts } from '@floway-dev/http/pipeline';
import { defineStage, move, secret, type Handed } from '@floway-dev/pipeline';
import { replaceHttpHeader, type ProviderServices } from '@floway-dev/provider';

export const authorizeCodexHeaders = defineStage<CodexHttpFacts, CodexHttpFacts, HttpResponseFacts, HttpResponseFacts, ProviderServices>({
  name: 'authorizeCodexHeaders',
  through: {
    request: {
      needs: ['request.codex.account', 'request.codex.accessToken', 'request.http.headers'],
      consumes: ['request.http.headers'],
      provides: ['request.http.headers'],
    },
    response: { needs: [], consumes: [], provides: [] },
  },
  execute: async (facts, next) => {
    const accountId = facts['request.codex.account'].chatgptAccountId;
    let headers = replaceHttpHeader(facts['request.http.headers'], 'authorization', secret(`Bearer ${facts['request.codex.accessToken'].token.reveal()}`));
    if (accountId !== null) headers = replaceHttpHeader(headers, 'chatgpt-account-id', accountId);
    return await next(move({ ...facts, 'request.http.headers': headers })) as Handed<HttpResponseFacts>;
  },
});
