import { defineStage } from './facts.ts';
import { isHttpBodyStream } from '@floway-dev/http';
import { move } from '@floway-dev/pipeline';
import { parseJsonBody } from '@floway-dev/provider';

// Sentinel verdicts use a small JSON error object. Bound the observer's copy
// independently of the body forwarded to the protocol parser.
const SENTINEL_BODY_LIMIT = 64 * 1024;

export const observeSentinel = defineStage({
  name: 'claude-code.observe-sentinel',
  through: {
    request: { needs: ['provider.upstream'], provides: [], consumes: [] },
    response: { needs: ['response.transport'], provides: ['response.transport'], consumes: [] },
  },
  execute: async (facts, scope) => {
    const back = await scope.next(facts);
    const transport = back['response.transport'];
    if (!transport.ok) return back;
    const { body, status } = transport.value;
    if ((status !== 400 && status !== 403) || !isHttpBodyStream(body)) return back;
    const upstreamId = facts['provider.upstream'].id;
    const observed = scope.wrapStream(body, async function* (source, producer) {
      const buffered = new Uint8Array(SENTINEL_BODY_LIMIT);
      let size = 0;
      let overflow = false;
      let failed = false;
      for await (const item of source) {
        if (!item.ok) {
          failed = true;
          producer.log.warn('claude_code_terminal_sentinel_body_read_failed', {
            upstream_id: upstreamId,
            upstream_status: status,
            error: String(item.error.cause),
          });
        } else if (!overflow) {
          if (size + item.value.byteLength > SENTINEL_BODY_LIMIT) {
            overflow = true;
            producer.log.warn('claude_code_terminal_sentinel_body_too_large', {
              upstream_id: upstreamId,
              upstream_status: status,
              limit_bytes: SENTINEL_BODY_LIMIT,
            });
          } else {
            buffered.set(item.value, size);
            size += item.value.byteLength;
          }
        }
        yield item;
      }
      if (failed || overflow) return;
      const bytes = buffered.subarray(0, size);
      const parsed = parseJsonBody(bytes);
      if (!parsed.ok) {
        producer.log.warn('claude_code_unparseable_error_body', { status, body_snippet: new TextDecoder().decode(bytes).slice(0, 256) });
        return;
      }
      const message = terminalMessage(status, parsed.value);
      if (message === null) return;
      producer.log.warn('claude_code_terminal_sentinel_detected', {
        upstream_id: upstreamId,
        upstream_status: status,
        reason: status === 400 ? 'org_disabled_400_sentinel' : 'org_banned_403_sentinel',
      });
      producer.defer(producer.services.claudeCode.persistTerminal(upstreamId, status, message));
    });
    return { ...back, 'response.transport': move({ ...transport, value: { ...transport.value, body: observed } }) };
  },
});

// https://github.com/anthropics/claude-code/issues/58393
const ORG_DISABLED = 'organization has been disabled';
// https://github.com/anthropics/claude-code/issues/65101
const ORG_BANNED = 'oauth authentication is currently not allowed';

const terminalMessage = (status: 400 | 403, body: unknown): string | null => {
  if (typeof body !== 'object' || body === null || !('error' in body)) return null;
  const { error } = body;
  if (typeof error !== 'object' || error === null || !('type' in error) || !('message' in error)
    || typeof error.message !== 'string') return null;
  const { type, message } = error;
  const lowered = message.toLowerCase();
  if (status === 400 && type === 'invalid_request_error' && lowered.includes(ORG_DISABLED)) {
    return `Organization disabled by Anthropic — re-import will not recover; contact support: ${message}`;
  }
  if (status === 403 && type === 'permission_error' && lowered.includes(ORG_BANNED)) {
    return `Organization banned from OAuth by Anthropic — re-import will not recover; contact support: ${message}`;
  }
  return null;
};
