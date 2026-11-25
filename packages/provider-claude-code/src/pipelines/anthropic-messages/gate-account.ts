import { defineStage } from './facts.ts';
import type { HttpHeaders, HttpResponseFact } from '@floway-dev/http';
import { move } from '@floway-dev/pipeline';

export const gateAccount = defineStage({
  name: 'claude-code.gate-account',
  through: {
    request: { needs: ['provider.upstream', 'provider.model'], provides: [], consumes: [] },
    response: { needs: ['response.http', 'response.modelKey', 'response.anthropicMessages'], provides: [], consumes: [] },
  },
  return: { provides: ['response.http', 'response.modelKey', 'response.anthropicMessages'] },
  async execute(facts, scope) {
    const now = Date.now();
    const { upstreamModelId: model } = facts['provider.model'];
    const blocked = await scope.services.claudeCode.requestBlock(facts['provider.upstream'].id, model, now);
    if (blocked === null) return await scope.next(facts);
    if (blocked.kind === 'terminal') return unavailable(model, blocked.message);
    return rateLimited(model, blocked.resetAt, now);
  },
});

export const unavailable = (model: string, message: string) => localError(
  model,
  503,
  { type: 'claude_code_upstream_unavailable', message },
  [],
);

const rateLimited = (model: string, resetAt: string, now: number) => localError(
  model,
  429,
  { type: 'claude_code_rate_limited', message: `Claude Code upstream rate-limited until ${resetAt}`, retry_at: resetAt },
  [['retry-after', String(Math.max(0, Math.ceil((Date.parse(resetAt) - now) / 1000)))]],
);

const localError = (model: string, status: 429 | 503, error: { type: string; message: string; retry_at?: string }, headers: HttpHeaders) => ({
  'response.http': move<HttpResponseFact>({
    status,
    statusText: status === 429 ? 'Too Many Requests' : 'Service Unavailable',
    headers: [['content-type', 'application/json'], ...headers],
    body: null,
  }),
  'response.modelKey': model,
  'response.anthropicMessages': move({ kind: 'error', source: 'local', error: { error } } as const),
});
