import { defineStage } from './facts.ts';
import { setHeader, type HttpHeaders } from '@floway-dev/http';
import type { Secret } from '@floway-dev/pipeline';
import type { UpstreamResponse } from '@floway-dev/upstream';

export const authorizeAndRetry = defineStage({
  name: 'claude-code.anthropic-messages.authorize-and-retry',
  through: {
    request: { needs: ['http', 'upstream', 'model'], provides: ['http'], consumes: [] },
    response: { needs: ['http'], provides: [], consumes: [] },
  },
  return: { provides: ['http', 'anthropicMessages'] },
  async execute(facts, scope) {
    const { id } = facts.upstream;
    const { claudeCode } = scope.services;
    const fetcher = scope.services.fetcher(id);
    const auth = await claudeCode.authorize(id, facts.model.upstreamModelId, fetcher);
    if (auth.kind === 'unavailable') return unavailable(auth.message);
    if (auth.kind === 'rate-limited') {
      return localError(429, {
        type: 'claude_code_rate_limited',
        message: `Claude Code upstream rate-limited until ${auth.reset}`,
        retry_at: auth.reset,
      }, [['retry-after', String(auth.retryAfterSeconds)]]);
    }

    const { http } = facts;
    const dial = (authorization: Secret<string>) => scope.next({
      ...facts,
      http: { ...http, headers: setHeader(http.headers, 'authorization', authorization) },
    });
    const first = dial(auth.header);
    const answer = await first;
    if (auth.freshlyMinted || answer.http?.status !== 401 || scope.signal.aborted) return answer;

    scope.abort(first);
    scope.discard(answer);
    const refreshed = await claudeCode.refreshAfterUnauthorized(id, fetcher);
    if (refreshed.kind === 'unavailable') return unavailable(refreshed.message);
    return await dial(refreshed.header);
  },
});

const localError = (
  status: number,
  error: { type: string; message: string; retry_at?: string },
  headers: HttpHeaders = [],
): UpstreamResponse<'anthropicMessages'> => ({
  http: { status, statusText: '', headers: [['content-type', 'application/json'], ...headers], body: null },
  anthropicMessages: { kind: 'error', source: 'local', error: { error } },
});

const unavailable = (message: string): UpstreamResponse<'anthropicMessages'> =>
  localError(503, { type: 'claude_code_upstream_unavailable', message });
