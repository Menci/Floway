import parseHttpDate from 'http-dates';

import { defineOperationStage, type Candidate, type GatewayPipelineFacts } from './facts.ts';
import { getHeader, type HttpResponseFact } from '@floway-dev/http';
import type { Deferred, Facts, ManagedStream } from '@floway-dev/pipeline';
import type { ProviderOperation } from '@floway-dev/provider';

type Handle = Deferred<unknown> | ManagedStream<unknown, unknown>;

interface FailedAttempt {
  call: Promise<Facts>;
  answer: Facts;
  candidate: Candidate;
  retryAt: number | null;
}

const selectedAnswer = (answer: Facts, { upstream, model }: Candidate) => ({
  ...answer,
  'response.candidate': { upstreamId: upstream.id, model: model.id },
});

// https://www.rfc-editor.org/rfc/rfc9110.html#section-10.2.3
const retryAt = (http: HttpResponseFact | null): number | null => {
  if (http === null) return null;
  const header = getHeader(http.headers, 'retry-after');
  if (typeof header !== 'string' || header.trim() === '') return null;
  const value = header.trim();
  const now = Date.now();
  if (/^\d+(?:\.\d+)?$/.test(value)) {
    const time = now + Number(value) * 1000;
    return Number.isFinite(time) ? time : null;
  }
  try {
    return Math.max(now, parseHttpDate(value).getTime());
  } catch {
    // http-dates throws for an invalid upstream header.
    return null;
  }
};

export const failover = <Op extends ProviderOperation>(
  operation: Op,
  losingHandles?: (answer: Facts) => readonly Handle[],
  options?: { attemptTargets: true },
) => {
  const outcome: string = `response.${operation}`;
  const payload = `request.${operation}`;
  const requestProvides: readonly string[] = ['provider.upstream', 'provider.model', 'request.aliasRules?', ...(options ? [payload] : [])];
  const responseNeeds: readonly string[] = ['response.http', outcome, 'response.usage?', 'response.performance?'];
  return defineOperationStage({
    name: `${operation}.failover`,
    through: {
      request: {
        needs: ['request.candidates'],
        provides: requestProvides,
        consumes: ['request.candidates'],
      },
      response: { needs: responseNeeds, provides: ['response.candidate'], consumes: [] },
    },
    async execute(facts, scope) {
      const { 'request.candidates': source, ...request } = facts;
      const candidates = source as readonly Candidate[];
      let selected: FailedAttempt | undefined;

      const discard = ({ call, answer }: FailedAttempt): void => {
        scope.abort(call);
        const body = (answer['response.http'] as HttpResponseFact | null)?.body;
        const usage = answer['response.usage'] as GatewayPipelineFacts['response.usage'] | undefined;
        const performance = answer['response.performance'] as GatewayPipelineFacts['response.performance'] | undefined;
        const handles = new Set(losingHandles?.(answer));
        if (body && !(body instanceof Uint8Array)) handles.add(body);
        if (usage) handles.add(usage);
        if (performance) handles.add(performance);
        for (const handle of handles) scope.discard(handle);
      };

      try {
        for (const candidate of candidates) {
          if (selected && scope.signal.aborted) break;
          if (selected?.retryAt === null) {
            discard(selected);
            selected = undefined;
          }
          const { upstream, model, rules } = candidate;
          if (options && !('payload' in candidate)) throw new Error(`The ${operation} candidate has no attempt payload`);
          const call = scope.next({
            ...request,
            'provider.upstream': upstream,
            'provider.model': model,
            ...(rules === undefined ? {} : { 'request.aliasRules': rules }),
            ...(options && 'payload' in candidate ? { [payload]: candidate.payload } : {}),
          });
          const answer = await call;
          if ((answer[outcome] as GatewayPipelineFacts[`response.${Op}`]).kind !== 'error') return selectedAnswer(answer, candidate);

          const failed = { call, answer, candidate, retryAt: retryAt(answer['response.http'] as HttpResponseFact | null) };
          if (selected?.retryAt != null && (failed.retryAt === null || selected.retryAt <= failed.retryAt)) {
            discard(failed);
          } else {
            if (selected) discard(selected);
            selected = failed;
          }
        }
        if (!selected) throw new Error('Failover requires at least one candidate');
        const answer = selectedAnswer(selected.answer, selected.candidate);
        selected = undefined;
        return answer;
      } finally {
        if (selected) discard(selected);
      }
    },
  });
};
