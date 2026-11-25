import { defineStage } from './facts.ts';
import { unavailable } from './gate-account.ts';
import { ClaudeCodeOAuthSessionTerminatedError, type ClaudeCodeOAuthFailure } from '../../auth/oauth.ts';
import { getHeader, isHttpBodyStream, setHeader } from '@floway-dev/http';
import { move, type Secret } from '@floway-dev/pipeline';
import { formatAnthropicMessagesError, parseAnthropicMessagesStream } from '@floway-dev/protocols/anthropic-messages';
import type { SseFrame } from '@floway-dev/protocols/common';
import { parseSseBody } from '@floway-dev/provider';

export const callAnthropicMessages = defineStage({
  name: 'claude-code.call-anthropic-messages',
  through: {
    request: {
      needs: ['request.http', 'provider.upstream', 'provider.model'],
      provides: ['request.http'],
      consumes: [],
    },
    response: {
      needs: ['response.transport'],
      provides: ['response.http', 'response.modelKey', 'response.anthropicMessages'],
      consumes: ['response.transport'],
    },
  },
  return: { provides: ['response.http', 'response.modelKey', 'response.anthropicMessages'] },
  async execute(facts, scope) {
    const request = facts['request.http'];
    const id = facts['provider.upstream'].id;
    const { upstreamModelId: model } = facts['provider.model'];
    const fetcher = scope.services.fetcher(id);
    const dispatch = (bearer: Secret<string>) => scope.next({
      ...facts,
      'request.http': move({ ...request, headers: setHeader(request.headers, 'authorization', bearer) }),
    });

    const authorized = await scope.services.claudeCode.authorization(id, fetcher);
    if (!authorized.ok) return oauthError(model, authorized.error);
    const { bearer, freshlyMinted } = authorized.value;
    const first = dispatch(bearer);
    let back = await first;
    const transport = back['response.transport'];
    if (transport.ok && transport.value.status === 401 && !freshlyMinted) {
      scope.abort(first);
      const { body } = transport.value;
      if (isHttpBodyStream(body)) {
        for await (const _item of body) {
          // The discarded response owns its I/O through native completion.
        }
      }
      const renewed = await scope.services.claudeCode.reauthorize(id, bearer, fetcher);
      if (!renewed.ok) return oauthError(model, renewed.error);
      back = await dispatch(renewed.value.bearer);
    }

    let rawFrameCount = 0;
    const rawFrames: { event: string | null; data: string }[] = [];
    const onSseFrame = ({ event, data }: SseFrame): void => {
      rawFrameCount += 1;
      rawFrames.push({ event: event ?? null, data: data.length > 256 ? `${data.slice(0, 253)}...` : data });
      if (rawFrames.length > 3) rawFrames.shift();
    };
    const { http, outcome } = await parseSseBody(
      back,
      scope,
      (body, options) => parseAnthropicMessagesStream(body, { ...options, onSseFrame }),
      { kind: 'terminalEvent', isTerminal: event => event.type === 'message_stop' || event.type === 'error' },
      formatAnthropicMessagesError,
    );
    const { 'response.transport': _transport, ...response } = back;
    if (outcome.kind !== 'stream') {
      return { ...response, 'response.http': move(http), 'response.modelKey': model, 'response.anthropicMessages': move(outcome) };
    }
    if (http === null) throw new TypeError('An Anthropic Messages stream requires its upstream response head');

    const stream = scope.wrapStream(outcome.stream, async function* (source, producer) {
      let terminalEvent: 'message_stop' | 'error' | null = null;
      let failed = false;
      const logIncomplete = (cause?: unknown): void => {
        if (producer.signal.aborted) return;
        producer.log.warn('claude_code_messages_stream_incomplete', {
          upstream_id: id,
          model,
          request_id: getHeader(http.headers, 'request-id'),
          cf_ray: getHeader(http.headers, 'cf-ray'),
          trace_response: getHeader(http.headers, 'traceresponse'),
          raw_sse_frames: rawFrameCount,
          terminal_event: terminalEvent,
          error: cause === undefined ? null : oneLineError(cause),
          last_sse_frames: JSON.stringify(rawFrames),
        });
      };
      try {
        for await (const item of source) {
          if (item.ok) {
            const { type } = item.value;
            if (type === 'message_stop' || type === 'error') terminalEvent = type;
          } else {
            failed = true;
            if (item.error.kind !== 'abort') logIncomplete(item.error.cause);
          }
          yield item;
        }
      } catch (error) {
        logIncomplete(error);
        throw error;
      }
      if (terminalEvent === null && !failed) logIncomplete();
    });
    return {
      ...response,
      'response.http': move(http),
      'response.modelKey': model,
      'response.anthropicMessages': move({ ...outcome, stream }),
    };
  },
});

const oauthError = (model: string, { http, body, cause }: ClaudeCodeOAuthFailure) => {
  if (http === null && cause instanceof ClaudeCodeOAuthSessionTerminatedError) {
    return unavailable(model, `Claude Code refresh failed: ${cause.upstreamMessage}`);
  }
  const reason = cause instanceof Error ? cause : cause.cause;
  const message = body?.kind === 'text' ? body.text : reason instanceof Error ? reason.message : String(reason);
  return {
    'response.http': move(http),
    'response.modelKey': model,
    'response.anthropicMessages': move({
      kind: 'error',
      source: 'upstream',
      error: body?.kind === 'json' ? body.value : formatAnthropicMessagesError(http?.status ?? null, message),
      cause,
    } as const),
  };
};

const oneLineError = (error: unknown): string => {
  const message = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim();
  return message.length > 512 ? `${message.slice(0, 509)}...` : message;
};
