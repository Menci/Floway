import { defineStage } from './facts.ts';
import { getHeader } from '@floway-dev/http';
import type { ProtocolStreamError } from '@floway-dev/upstream';

const RETAINED_EVENTS = 3;
const MAX_ERROR_MESSAGE_CHARS = 512;
// https://platform.claude.com/docs/en/build-with-claude/streaming#event-types
const EVENT_TYPES = new Set([
  'message_start', 'message_delta', 'message_stop',
  'content_block_start', 'content_block_delta', 'content_block_stop',
  'ping', 'error',
]);

export const observeStream = defineStage({
  name: 'claude-code.anthropic-messages.observe-stream',
  through: {
    request: { needs: ['upstream', 'model'], provides: [], consumes: [] },
    response: { needs: ['http', 'anthropicMessages'], provides: ['anthropicMessages'], consumes: [] },
  },
  async execute(facts, scope) {
    const answer = await scope.next(facts);
    const { anthropicMessages, http } = answer;
    if (anthropicMessages.kind !== 'stream') return answer;
    if (http === null) throw new Error('Claude Code stream requires upstream HTTP headers');

    const stream = scope.wrapStream(anthropicMessages.stream, async function* (inner, producer) {
      let stopped = false;
      let failure: ProtocolStreamError['kind'] | 'panic' | undefined;
      let cause: unknown;
      let count = 0;
      const recent: string[] = [];
      try {
        for await (const item of producer.read(inner)) {
          if (item.ok) {
            const { type } = item.value;
            count += 1;
            if (recent.length === RETAINED_EVENTS) recent.shift();
            recent.push(EVENT_TYPES.has(type) ? type : 'unknown');
            if (type === 'message_stop') stopped = true;
          } else {
            failure = item.error.kind;
            cause = item.error.cause;
          }
          yield item;
        }
      } catch (error) {
        failure = 'panic';
        cause = error;
        throw error;
      } finally {
        if (failure !== 'abort' && (!stopped || failure !== undefined)) {
          producer.log.withFields({
            upstream_id: facts.upstream.id,
            model: facts.model.upstreamModelId,
            request_id: getHeader(http.headers, 'request-id'),
            cf_ray: getHeader(http.headers, 'cf-ray'),
            trace_response: getHeader(http.headers, 'traceresponse'),
            events: count,
            terminal_event: stopped ? 'message_stop' : null,
            failure_kind: failure,
            error: failure === undefined ? null : diagnosticError(cause),
            last_event_types: recent,
          }).warn('claude_code_messages_stream_incomplete');
        }
      }
    });
    return { ...answer, anthropicMessages: { kind: 'stream', stream } };
  },
});

const diagnosticError = (error: unknown): string => {
  const message = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim();
  return message.length > MAX_ERROR_MESSAGE_CHARS ? `${message.slice(0, MAX_ERROR_MESSAGE_CHARS - 3)}...` : message;
};
