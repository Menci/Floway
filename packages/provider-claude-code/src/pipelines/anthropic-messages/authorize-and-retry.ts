import { defineStage } from './facts.ts';
import { claudeCodeUpstreamModelId } from '../../models.ts';
import { setHeader, type HttpHeaders } from '@floway-dev/http';
import type { ProviderResponseFacts } from '@floway-dev/provider';

export const authorizeAndRetry = defineStage({
  name: 'claude-code.anthropic-messages.authorize-and-retry',
  through: {
    request: { needs: ['request.http', 'provider.upstream', 'provider.model'], provides: ['request.http'], consumes: [] },
    response: { needs: ['response.http', 'response.anthropicMessages?'], provides: [], consumes: [] },
  },
  return: { provides: ['response.http', 'response.anthropicMessages'] },
  async execute(facts, scope) {
    const { id } = facts['provider.upstream'];
    const upstreamModelId = claudeCodeUpstreamModelId(facts['provider.model']);
    const { claudeCode } = scope.services;
    const fetcher = scope.services.fetcher(id);
    const auth = await claudeCode.authorize(id, upstreamModelId, fetcher, scope.log);
    if (auth.kind === 'unavailable') return unavailable(auth.message);
    if (auth.kind === 'rate-limited') {
      return localError(429, {
        type: 'claude_code_rate_limited',
        message: `Claude Code upstream rate-limited until ${auth.reset}`,
        retry_at: auth.reset,
      }, [['retry-after', String(auth.retryAfterSeconds)]]);
    }

    const request = facts['request.http'];
    const call = (header: typeof auth.header) => scope.next({
      ...facts,
      'request.http': { ...request, headers: setHeader(request.headers, 'authorization', header) },
    });
    const first = call(auth.header);
    const answer = await first;
    const http = answer['response.http'];
    if (auth.freshlyMinted || http?.status !== 401 || scope.signal.aborted) return answer;

    scope.abort(first);
    if (http.body !== null && !(http.body instanceof Uint8Array)) scope.discard(http.body);

    const refreshed = await claudeCode.refreshAfterUnauthorized(id, fetcher, scope.log);
    if (refreshed.kind === 'unavailable') return unavailable(refreshed.message);
    return await call(refreshed.header);
  },
});

const localError = (
  status: number,
  error: { type: string; message: string; retry_at?: string },
  headers: HttpHeaders,
): ProviderResponseFacts<'anthropicMessages'> => ({
  'response.http': { status, statusText: '', headers: [['content-type', 'application/json'], ...headers], body: null },
  'response.anthropicMessages': { kind: 'error', source: 'local', error: { error } },
});

const unavailable = (message: string): ProviderResponseFacts<'anthropicMessages'> =>
  localError(503, { type: 'claude_code_upstream_unavailable', message }, []);
