import { defineStage } from './facts.ts';
import { formatAnthropicError } from './parse-response.ts';
import { pickClaudeCodeHeaders } from '../../headers.ts';
import { getHeader, hasHeader, setHeader } from '@floway-dev/http';
import { httpDialError } from '@floway-dev/upstream';

// https://github.com/anthropics/anthropic-sdk-typescript/blob/3b45cd3b69c956ac63384fdb09ce1d8109f3fa80/src/resources/beta/messages/messages.ts
const ANTHROPIC_MESSAGES_ENDPOINT = 'https://api.anthropic.com/v1/messages?beta=true';

export const dial = defineStage({
  name: 'claude-code.anthropic-messages.dial',
  through: {
    request: {
      needs: ['http', 'anthropicMessages', 'claudeCode.shaped', 'model'],
      provides: ['http'],
      consumes: ['claudeCode.shaped'],
    },
    response: {
      needs: ['http', 'http.error?'],
      provides: ['anthropicMessages?'],
      consumes: ['http.error'],
    },
  },
  async execute(facts, scope) {
    const { 'claudeCode.shaped': shaped, ...request } = facts;
    const { http, model } = request;
    const authorization = getHeader(http.headers, 'authorization');
    if (authorization === undefined || typeof authorization === 'string') {
      throw new TypeError('Claude Code requires a secret authorization header');
    }
    const headers = shaped
      ? http.headers
      : setHeader(Object.entries(pickClaudeCodeHeaders(model.upstreamModelId)), 'authorization', authorization);
    const payload = { ...facts.anthropicMessages, model: model.upstreamModelId, stream: true };
    const { 'http.error': failure, ...answer } = await scope.next({
      ...request,
      http: {
        ...http,
        method: 'POST',
        url: ANTHROPIC_MESSAGES_ENDPOINT,
        headers: hasHeader(headers, 'content-type') ? headers : setHeader(headers, 'content-type', 'application/json'),
        body: JSON.stringify(payload),
      },
    });
    return failure === undefined
      ? answer
      : { ...answer, anthropicMessages: httpDialError(failure, formatAnthropicError) };
  },
});
