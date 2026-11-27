import { defineStage } from './facts.ts';
import { decodeAnthropicMessagesStream } from '@floway-dev/protocols/anthropic-messages';
import { parseUpstreamStream, protocolErrorDebugFields, type FormatProtocolError } from '@floway-dev/upstream';

const MAX_ERROR_BODY_BYTES = 2 * 1024 * 1024;

// https://platform.claude.com/docs/en/api/errors
export const formatAnthropicError: FormatProtocolError = (status, message, diagnostic) => ({
  type: 'error',
  error: {
    type: status === 429 ? 'rate_limit_error' : status !== null && status < 500 ? 'invalid_request_error' : 'api_error',
    message,
    ...protocolErrorDebugFields(diagnostic),
  },
});

export const parseResponse = defineStage({
  name: 'claude-code.anthropic-messages.parse-response',
  through: {
    request: { needs: [], provides: [], consumes: [] },
    response: { needs: ['http', 'anthropicMessages?'], provides: ['http', 'anthropicMessages'], consumes: [] },
  },
  async execute(facts, scope) {
    const answer = await scope.next(facts);
    if (answer.anthropicMessages !== undefined) return { ...answer, anthropicMessages: answer.anthropicMessages };
    if (answer.http === null) throw new Error('Claude Code requires HTTP response headers or a dial error');
    const parsed = await parseUpstreamStream(answer.http, scope, decodeAnthropicMessagesStream, formatAnthropicError, MAX_ERROR_BODY_BYTES);
    return { ...answer, http: parsed.http, anthropicMessages: parsed.outcome };
  },
});
