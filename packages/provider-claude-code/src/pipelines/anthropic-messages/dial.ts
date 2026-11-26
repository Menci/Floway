import { defineStage } from './facts.ts';
import { formatAnthropicError } from './parse-response.ts';
import { pickClaudeCodeHeaders } from '../../headers.ts';
import { claudeCodeUpstreamModelId } from '../../models.ts';
import { getHeader, hasHeader, setHeader } from '@floway-dev/http';
import { Secret } from '@floway-dev/pipeline';
import { httpDialError } from '@floway-dev/provider';

// https://github.com/anthropics/anthropic-sdk-typescript/blob/3b45cd3b69c956ac63384fdb09ce1d8109f3fa80/src/resources/beta/messages/messages.ts
const ANTHROPIC_MESSAGES_ENDPOINT = 'https://api.anthropic.com/v1/messages?beta=true';
const encoder = new TextEncoder();

export const dial = defineStage({
  name: 'claude-code.anthropic-messages.dial',
  through: {
    request: {
      needs: ['request.http', 'request.anthropicMessages', 'request.claudeCodeShaped', 'provider.model'],
      provides: ['request.http'],
      consumes: ['request.claudeCodeShaped'],
    },
    response: {
      needs: ['response.http', 'response.http.error?'],
      provides: ['response.anthropicMessages?', 'response.usageModelKey?'],
      consumes: ['response.http.error'],
    },
  },
  async execute(facts, scope) {
    const { 'request.claudeCodeShaped': shaped, ...request } = facts;
    const http = request['request.http'];
    const upstreamModelId = claudeCodeUpstreamModelId(request['provider.model']);
    const authorization = getHeader(http.headers, 'authorization');
    if (!(authorization instanceof Secret)) throw new TypeError('Claude Code requires a secret authorization header');
    const headers = shaped
      ? http.headers
      : setHeader(Object.entries(pickClaudeCodeHeaders(upstreamModelId)), 'authorization', authorization);
    const payload = { ...facts['request.anthropicMessages'], model: upstreamModelId, stream: true };
    const { 'response.http.error': error, ...result } = await scope.next({
      ...request,
      'request.http': {
        ...http,
        method: 'POST',
        url: ANTHROPIC_MESSAGES_ENDPOINT,
        headers: hasHeader(headers, 'content-type') ? headers : setHeader(headers, 'content-type', 'application/json'),
        body: encoder.encode(JSON.stringify(payload)),
      },
    });
    const answer = error?.kind === 'abort' ? result : { ...result, 'response.usageModelKey': payload.model };
    return error === undefined
      ? answer
      : { ...answer, 'response.anthropicMessages': httpDialError(error, formatAnthropicError) };
  },
});
