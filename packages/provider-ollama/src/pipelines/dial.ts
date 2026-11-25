import { defineStage, type OllamaFacts, type OllamaOperation } from './facts.ts';
import { setHeader } from '@floway-dev/http';
import { httpDialError, joinBaseAndPath, type FormatProtocolError, type ProviderModelFact } from '@floway-dev/provider';

type WireRequest = { path: string; contentType: string; body: Uint8Array };

export const ollamaDial = <Op extends OllamaOperation>(
  operation: Op,
  prepare: (payload: OllamaFacts[`request.${Op}`], model: ProviderModelFact) => WireRequest | Promise<WireRequest>,
  format: FormatProtocolError,
) => {
  const payload = `request.${operation}` as `request.${OllamaOperation}`;
  const outcome = `response.${operation}` as `response.${OllamaOperation}`;
  return defineStage({
    name: `ollama.${operation}.dial`,
    through: {
      request: { needs: ['request.http', 'provider.upstream', 'provider.model', payload], provides: ['request.http'], consumes: [] },
      response: { needs: ['response.http', 'response.http.error?'], provides: [`${outcome}?`], consumes: ['response.http.error'] },
    },
    async execute(facts, scope) {
      const request = facts['request.http'];
      const { baseUrl, apiKey } = facts['provider.upstream'].config;
      const { path, contentType, body } = await prepare(facts[payload] as OllamaFacts[`request.${Op}`], facts['provider.model']);
      let headers = setHeader(request.headers, 'content-type', contentType);
      if (apiKey !== undefined) headers = setHeader(headers, 'authorization', apiKey.map(value => `Bearer ${value}`));
      const { 'response.http.error': failure, ...answer } = await scope.next({
        ...facts,
        'request.http': { ...request, url: joinBaseAndPath(baseUrl, path), method: 'POST', headers, body },
      });
      return failure === undefined ? answer : { ...answer, [outcome]: httpDialError(failure, format) };
    },
  });
};

export const jsonRequest = (path: string, payload: object): WireRequest => ({
  path,
  contentType: 'application/json',
  body: new TextEncoder().encode(JSON.stringify(payload)),
});
