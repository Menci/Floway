import { defineStage } from './facts.ts';
import { diagnosticError, diagnosticText } from '../../log.ts';
import { isJsonObject } from '@floway-dev/protocols/common';
import { parseJsonBody } from '@floway-dev/provider';

// https://github.com/anthropics/claude-code/issues/8327
const ORG_DISABLED_400_SENTINEL = 'organization has been disabled';
// https://github.com/anthropics/claude-code/issues/68370
const ORG_BANNED_403_SENTINEL = 'oauth authentication is currently not allowed';
const SENTINEL_BODY_LIMIT = 64 * 1024;

export const observeSentinel = defineStage({
  name: 'claude-code.anthropic-messages.observe-sentinel',
  through: {
    request: { needs: ['provider.upstream'], provides: [], consumes: [] },
    response: { needs: ['response.http'], provides: ['response.http'], consumes: [] },
  },
  async execute(facts, scope) {
    const answer = await scope.next(facts);
    const http = answer['response.http'];
    if (http === null || (http.status !== 400 && http.status !== 403)) return answer;
    const { status, body } = http;
    if (body === null) {
      scope.log.withFields({ status, body_snippet: '' }).warn('claude_code_unparseable_error_body');
      return answer;
    }
    if (body instanceof Uint8Array) throw new TypeError('Claude Code sentinel observer requires an unopened HTTP body stream');

    const { id } = facts['provider.upstream'];
    const observed = scope.wrapStream(body, async function* (inner, producer) {
      const chunks: Uint8Array[] = [];
      let length = 0;
      let oversized = false;
      let failed = false;
      const logReadFailure = (error: unknown) => {
        producer.log.withFields({
          upstream_id: id,
          upstream_status: status,
          error: diagnosticError(error),
        }).warn('claude_code_terminal_sentinel_body_read_failed');
      };

      try {
        for await (const item of producer.read(inner)) {
          if (!item.ok) {
            failed = true;
            logReadFailure(item.error.cause);
          } else if (!oversized && item.value.byteLength !== 0) {
            length += item.value.byteLength;
            if (length <= SENTINEL_BODY_LIMIT) {
              chunks.push(item.value);
            } else {
              oversized = true;
              chunks.length = 0;
              producer.log.withFields({
                upstream_id: id,
                upstream_status: status,
                limit_bytes: SENTINEL_BODY_LIMIT,
              }).warn('claude_code_terminal_sentinel_body_too_large');
            }
          }
          yield item;
        }
      } catch (error) {
        logReadFailure(error);
        throw error;
      }
      if (failed || oversized) return;

      const bytes = concatChunks(chunks, length);
      const parsed = parseJsonBody(bytes);
      if (!parsed.ok) {
        producer.log.withFields({
          status,
          body_snippet: diagnosticText(new TextDecoder().decode(bytes), 256),
        }).warn('claude_code_unparseable_error_body');
        return;
      }

      const message = detectSentinel(status, parsed.value);
      if (message === null) return;
      producer.detach(async ({ services, log }) => {
        try {
          await services.claudeCode.persistSentinel(id, message, status, log);
        } catch (error) {
          log.withFields({ upstream_id: id, upstream_status: status }).withError(error).warn('claude_code_terminal_sentinel_persist_failed');
        }
      });
    });
    return { ...answer, 'response.http': { ...http, body: observed } };
  },
});

const concatChunks = (chunks: readonly Uint8Array[], length: number): Uint8Array => {
  if (chunks.length === 1) return chunks[0]!;
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
};

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
