import { defineStage } from './facts.ts';
import { diagnosticError, diagnosticPayload } from '../../log.ts';
import { claudeCodeUpstreamModelId } from '../../models.ts';
import { getHeader } from '@floway-dev/http';
import type { ProtocolStreamError } from '@floway-dev/provider';

const RETAINED_FRAMES = 3;
// https://platform.claude.com/docs/en/build-with-claude/streaming#event-types
const EVENT_TYPES = new Set([
  'message_start', 'message_delta', 'message_stop',
  'content_block_start', 'content_block_delta', 'content_block_stop',
  'ping', 'error',
]);

export const observeStream = defineStage({
  name: 'claude-code.anthropic-messages.observe-stream',
  through: {
    request: { needs: ['provider.upstream', 'provider.model'], provides: [], consumes: [] },
    response: {
      needs: ['response.http', 'response.anthropicMessages'],
      provides: ['response.anthropicMessages'],
      consumes: [],
    },
  },
  async execute(facts, scope) {
    const answer = await scope.next(facts);
    const outcome = answer['response.anthropicMessages'];
    const http = answer['response.http'];
    if (outcome.kind !== 'stream') return answer;
    if (http === null) throw new Error('Claude Code stream requires upstream HTTP headers');

    const { id } = facts['provider.upstream'];
    const upstreamModelId = claudeCodeUpstreamModelId(facts['provider.model']);
    const stream = scope.wrapStream(outcome.stream, async function* (inner, producer) {
      let terminal: 'message_stop' | 'error' | undefined;
      let failure: ProtocolStreamError['kind'] | 'panic' | undefined;
      let cause: unknown;
      let count = 0;
      const recent: { event: string; data: string }[] = [];
      try {
        for await (const item of producer.read(inner)) {
          if (item.ok) {
            const { type } = item.value;
            count += 1;
            if (recent.length === RETAINED_FRAMES) recent.shift();
            recent.push({ event: EVENT_TYPES.has(type) ? type : 'unknown', data: diagnosticPayload(item.value) });
            if (type === 'message_stop' || type === 'error') terminal = type;
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
        if (failure !== 'abort' && (terminal === undefined || failure !== undefined)) {
          producer.log.withFields({
            upstream_id: id,
            model: upstreamModelId,
            request_id: getHeader(http.headers, 'request-id'),
            cf_ray: getHeader(http.headers, 'cf-ray'),
            trace_response: getHeader(http.headers, 'traceresponse'),
            events: count,
            terminal_event: terminal,
            failure_kind: failure,
            error: failure === undefined ? null : diagnosticError(cause),
            last_event_frames: recent,
          }).warn('claude_code_messages_stream_incomplete');
        }
      }
    });
    return { ...answer, 'response.anthropicMessages': { kind: 'stream', stream } };
  },
});
