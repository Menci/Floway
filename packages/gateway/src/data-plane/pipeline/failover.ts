import parseHttpDate from 'http-dates';

import { gatewayFactSpace, type GatewayPipelineFacts, type ProtocolResponseKey, type ServeCandidate, type ServeCandidates } from './facts.ts';
import { getHeader, type HttpResponseFact } from '@floway-dev/http';
import { isManagedStream, move, type Facts, type ManagedStream } from '@floway-dev/pipeline';
import type { GatewayFacts } from '@floway-dev/provider';

type AttemptResponse<Key extends ProtocolResponseKey> = Pick<GatewayPipelineFacts, 'response.http' | Key>;
type ProtocolRequestKey = Exclude<Extract<keyof GatewayFacts, `request.${string}`>, 'request.http'>;

export interface AttemptPreparation<Request extends ProtocolRequestKey, Response extends ProtocolResponseKey, Services> {
  readonly requestKey: Request;
  readonly prepare: (
    candidates: readonly ServeCandidate[],
    payload: GatewayPipelineFacts[Request],
    services: Readonly<Services>,
  ) => Promise<
    | { readonly kind: 'targets'; readonly targets: readonly { readonly candidate: ServeCandidate; readonly payload: GatewayPipelineFacts[Request] }[] }
    | { readonly kind: 'unavailable'; readonly message: string }
  >;
  readonly unavailable: (message: string) => AttemptResponse<Response>;
}

export const failover = <
  const Key extends ProtocolResponseKey,
  const Request extends ProtocolRequestKey = never,
  Services = {},
>(
  responseKey: Key,
  unavailable: (model: string, discovery: ServeCandidates) => AttemptResponse<Key>,
  servesOperation: (candidate: ServeCandidate) => boolean,
  preparation?: AttemptPreparation<Request, NoInfer<Key>, Services>,
) => {
  const { defineStage } = gatewayFactSpace<Services>();
  const payloadKeys = preparation === undefined ? [] : [preparation.requestKey];
  const through = {
    request: {
      needs: ['serve.model', 'serve.candidates', ...payloadKeys],
      provides: ['serve.candidate', ...payloadKeys],
      consumes: ['serve.candidates'],
    },
    response: { needs: ['response.http', responseKey], provides: [], consumes: [] },
  } as const;
  type ThroughStage = Parameters<typeof defineStage<typeof through>>[0];
  type SelectedAnswer = Awaited<ReturnType<ThroughStage['execute']>>;
  return defineStage({
    name: 'serve.failover',
    through,
    return: { provides: ['response.http', responseKey] },
    async execute({ 'serve.candidates': discovery, ...facts }, scope) {
      const candidates = discovery.candidates.filter(servesOperation);
      let targets: readonly { readonly candidate: ServeCandidate; readonly request?: Facts }[];
      if (preparation === undefined) {
        targets = candidates.map(candidate => ({ candidate }));
      } else {
        const key = preparation.requestKey;
        const selected = await preparation.prepare(candidates, facts[key] as unknown as GatewayPipelineFacts[Request], scope.services);
        if (selected.kind === 'unavailable') return preparation.unavailable(selected.message) as SelectedAnswer;
        targets = selected.targets.map(({ candidate, payload }) => ({ candidate, request: { [key]: move(payload) } }));
      }
      if (targets.length === 0) return unavailable(facts['serve.model'], discovery) as SelectedAnswer;

      const answer = await chooseCandidate(
        targets,
        ({ candidate, request }) => {
          const handoff = { ...facts, ...request, 'serve.candidate': move(candidate) };
          return scope.next(handoff as Parameters<typeof scope.next>[0]);
        },
        candidate => candidate[responseKey].kind !== 'error',
        scope,
      );
      return answer as SelectedAnswer;
    },
  });
};

const chooseCandidate = async <Target, Answer extends { readonly 'response.http': HttpResponseFact | null }>(
  candidates: readonly Target[],
  runCandidate: (candidate: Target) => Promise<Answer>,
  isSuccess: (answer: Answer) => boolean,
  { signal, abort }: { readonly signal: AbortSignal; readonly abort: (call: object) => void },
): Promise<Answer> => {
  type CandidateAnswer = { readonly call: Promise<Answer>; readonly answer: Answer; readonly retry: number | null };
  const discard = async ({ call, answer }: Pick<CandidateAnswer, 'call' | 'answer'>): Promise<void> => {
    abort(call);
    await drainAnswer(answer);
  };

  let selected: CandidateAnswer | undefined;
  for (const candidate of candidates) {
    const call = runCandidate(candidate);
    const answer = await call;
    if (isSuccess(answer)) {
      if (selected) await discard(selected);
      return answer;
    }

    const http = answer['response.http'];
    const hint = http === null ? undefined : getHeader(http.headers, 'retry-after');
    const retry = typeof hint === 'string' ? retryTime(hint) : null;
    if (selected?.retry != null && (retry === null || retry >= selected.retry)) {
      await discard({ call, answer });
    } else {
      if (selected) await discard(selected);
      selected = { call, answer, retry };
    }
    if (signal.aborted) break;
  }
  return selected!.answer;
};

// https://www.rfc-editor.org/rfc/rfc9110.html#section-10.2.3
const retryTime = (retryAfter: string): number | null => {
  const value = retryAfter.trim();
  if (!value) return null;
  const now = Date.now();
  if (/^\d+(?:\.\d+)?$/.test(value)) {
    const time = now + Number(value) * 1000;
    return Number.isFinite(time) ? time : null;
  }
  try {
    return Math.max(now, parseHttpDate(value).getTime());
  } catch {
    // http-dates signals malformed input by throwing.
    return null;
  }
};

const drainAnswer = async (answer: Facts): Promise<void> => {
  const visited = new WeakSet<object>();
  const streams: ManagedStream<unknown, unknown>[] = [];
  const visit = (value: unknown) => {
    if (typeof value !== 'object' || value === null || ArrayBuffer.isView(value) || visited.has(value)) return;
    visited.add(value);
    if (isManagedStream(value)) streams.push(value);
    else for (const child of Object.values(value)) visit(child);
  };
  visit(answer);
  await Promise.all(streams.map(async stream => {
    for await (const _ of stream) {
      // Discard the answer through native done after aborting its branch.
    }
  }));
};
