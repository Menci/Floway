import { defineStage } from './facts.ts';
import { isHttpBodyStream } from '@floway-dev/http';
import { move } from '@floway-dev/pipeline';

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
      const decoder = new TextDecoder();
      let text = '';
      let failed = false;
      for await (const item of source) {
        if (item.ok) {
          text += decoder.decode(item.value, { stream: true });
        } else {
          failed = true;
          producer.log.warn('claude_code_terminal_sentinel_body_read_failed', {
            upstream_id: upstreamId,
            upstream_status: status,
            error: String(item.error.cause),
          });
        }
        yield item;
      }
      if (failed) return;
      text += decoder.decode();
      const parsed = parseErrorBody(text);
      if (parsed.invalidJson) {
        producer.log.warn('claude_code_unparseable_error_body', { status, body_snippet: text.slice(0, 256) });
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

const parseErrorBody = (text: string): { invalidJson: true } | { invalidJson: false; value: unknown } => {
  try {
    return { invalidJson: false, value: JSON.parse(text) as unknown };
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return { invalidJson: true };
  }
};

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
