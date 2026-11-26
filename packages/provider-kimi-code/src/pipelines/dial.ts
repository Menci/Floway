import { defineStage } from './facts.ts';
import { kimiCodeUrl } from '../fetch.ts';
import { setHeader } from '@floway-dev/http';
import { httpDialError, type FormatProtocolError } from '@floway-dev/provider';

export const formatOpenAIError: FormatProtocolError = (status, message) => ({
  error: { type: status === null || status >= 500 ? 'api_error' : 'invalid_request_error', message },
});

export const formatAnthropicError: FormatProtocolError = (status, message) => ({
  type: 'error',
  error: { type: status === null || status >= 500 ? 'api_error' : 'invalid_request_error', message },
});

export const kimiCodeDial = (
  operation: 'openaiChatCompletions' | 'openaiResponses' | 'anthropicMessages' | 'anthropicMessagesCountTokens',
  path: string,
  format: FormatProtocolError,
) => {
  const payload = `request.${operation}` as const;
  const outcome = `response.${operation}` as const;
  return defineStage({
    name: `kimi-code.${operation}.dial`,
    through: {
      request: { needs: ['request.http', 'provider.upstream', payload], provides: ['request.http'], consumes: [] },
      response: { needs: ['response.http', 'response.http.error?'], provides: [`${outcome}?`, 'response.usageModelKey'], consumes: ['response.http.error'] },
    },
    async execute(facts, scope) {
      const request = facts['request.http'];
      const body = facts[payload];
      const { config } = facts['provider.upstream'];
      const headers = setHeader(setHeader(request.headers, 'content-type', 'application/json'), 'authorization', config.apiKey.map(value => `Bearer ${value}`));
      const { 'response.http.error': failure, ...response } = await scope.next({
        ...facts,
        'request.http': {
          ...request,
          url: kimiCodeUrl(config.region, path),
          method: 'POST',
          headers,
          body: new TextEncoder().encode(JSON.stringify(body)),
        },
      });
      const answer = { ...response, 'response.usageModelKey': body.model };
      return failure === undefined ? answer : { ...answer, [outcome]: httpDialError(failure, format) };
    },
  });
};
