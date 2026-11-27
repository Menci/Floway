import { defineStage } from './facts.ts';
import { isJsonObject } from '@floway-dev/protocols/common';

// https://github.com/anthropics/claude-code/issues/8327
const ORG_DISABLED_400_SENTINEL = 'organization has been disabled';
// https://github.com/anthropics/claude-code/issues/68370
const ORG_BANNED_403_SENTINEL = 'oauth authentication is currently not allowed';
const MAX_SENTINEL_BODY_BYTES = 64 * 1024;

export const observeSentinel = defineStage({
  name: 'claude-code.anthropic-messages.observe-sentinel',
  through: {
    request: { needs: ['upstream'], provides: [], consumes: [] },
    response: { needs: ['http'], provides: ['http'], consumes: [] },
  },
  async execute(facts, scope) {
    const answer = await scope.next(facts);
    const { http } = answer;
    if (http === null || (http.status !== 400 && http.status !== 403)) return answer;
    const { status, body } = http;
    const { id } = facts.upstream;
    if (body === null) {
      scope.log.withFields({ upstream_id: id, upstream_status: status, body_snippet: '' }).warn('claude_code_unparseable_error_body');
      return answer;
    }
    if (body instanceof Uint8Array) throw new TypeError('Claude Code sentinel observer requires an unopened HTTP body stream');

    const observed = scope.wrapStream(body, async function* (inner, producer) {
      let bytesSeen = 0;
      let text = '';
      let failed = false;
      const decoder = new TextDecoder();
      const log = producer.log.withFields({ upstream_id: id, upstream_status: status });
      for await (const item of producer.read(inner)) {
        if (!item.ok) {
          failed = true;
          log.withError(item.error.cause).warn('claude_code_terminal_sentinel_body_read_failed');
        } else if (bytesSeen <= MAX_SENTINEL_BODY_BYTES) {
          bytesSeen += item.value.byteLength;
          if (bytesSeen <= MAX_SENTINEL_BODY_BYTES) {
            text += decoder.decode(item.value, { stream: true });
          } else {
            text = '';
            log.withField('limit_bytes', MAX_SENTINEL_BODY_BYTES).warn('claude_code_terminal_sentinel_body_too_large');
          }
        }
        yield item;
      }
      if (failed || bytesSeen > MAX_SENTINEL_BODY_BYTES) return;

      text += decoder.decode();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        log.withField('body_snippet', text.slice(0, 256)).warn('claude_code_unparseable_error_body');
        return;
      }
      const message = detectSentinel(status, parsed);
      if (message === null) return;
      producer.detach(async ({ services, log }) => {
        try {
          await services.claudeCode.persistSentinel(id, message, status);
        } catch (error) {
          log.withFields({ upstream_id: id, upstream_status: status }).withError(error).warn('claude_code_terminal_sentinel_persist_failed');
          throw error;
        }
      });
    });
    return { ...answer, http: { ...http, body: observed } };
  },
});

const detectSentinel = (status: 400 | 403, body: unknown): string | null => {
  if (!isJsonObject(body) || !isJsonObject(body.error)) return null;
  const { type, message } = body.error;
  if (typeof message !== 'string') return null;
  const lowered = message.toLowerCase();
  if (status === 400 && type === 'invalid_request_error' && lowered.includes(ORG_DISABLED_400_SENTINEL)) {
    return `Organization disabled by Anthropic — re-import will not recover; contact support: ${message}`;
  }
  if (status === 403 && type === 'permission_error' && lowered.includes(ORG_BANNED_403_SENTINEL)) {
    return `Organization banned from OAuth by Anthropic — re-import will not recover; contact support: ${message}`;
  }
  return null;
};
