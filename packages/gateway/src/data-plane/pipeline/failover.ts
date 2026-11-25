import { gatewayFactSpace, type GatewayPipelineFacts, type ProtocolResponseKey, type ServeCandidate, type ServeCandidates } from './facts.ts';
import { retryTime } from '../shared/iterate-candidates.ts';
import { getHeader, type HttpResponseFact } from '@floway-dev/http';
import { move, type Facts } from '@floway-dev/pipeline';

const { defineStage } = gatewayFactSpace<{}>();

type AttemptResponse<Key extends ProtocolResponseKey> = Pick<GatewayPipelineFacts, 'response.http' | Key>;

export const failover = <const Key extends ProtocolResponseKey>(
  responseKey: Key,
  unavailable: (model: string, discovery: ServeCandidates) => AttemptResponse<Key>,
  servesOperation: (candidate: ServeCandidate) => boolean,
) => {
  const through = {
    request: { needs: ['serve.model', 'serve.candidates'], provides: ['serve.candidate'], consumes: ['serve.candidates'] },
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
      if (candidates.length === 0) return unavailable(facts['serve.model'], discovery) as SelectedAnswer;

      const answer = await chooseCandidate(
        candidates,
        candidate => scope.next({ ...facts, 'serve.candidate': move(candidate) }),
        candidate => candidate[responseKey].kind !== 'error',
        scope,
      );
      return answer as SelectedAnswer;
    },
  });
};

const chooseCandidate = async <Answer extends { readonly 'response.http': HttpResponseFact | null }>(
  candidates: readonly ServeCandidate[],
  runCandidate: (candidate: ServeCandidate) => Promise<Answer>,
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

const drainAnswer = async (answer: Facts): Promise<void> => {
  const visited = new WeakSet<object>();
  const streams: AsyncIterable<unknown>[] = [];
  const visit = (value: unknown) => {
    if (typeof value !== 'object' || value === null || ArrayBuffer.isView(value) || visited.has(value)) return;
    visited.add(value);
    if (Symbol.asyncIterator in value) streams.push(value as AsyncIterable<unknown>);
    else for (const child of Object.values(value)) visit(child);
  };
  visit(answer);
  await Promise.all(streams.map(async stream => {
    for await (const _ of stream) {
      // Discard the answer through native done after aborting its branch.
    }
  }));
};
