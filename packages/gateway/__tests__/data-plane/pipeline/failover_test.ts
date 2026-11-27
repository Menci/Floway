import { expect, test, vi } from 'vitest';

import { candidateFor, hostFor } from './fixtures.ts';
import type { Candidate, SelectedCandidate } from '../../../src/data-plane/pipeline/facts.ts';
import { selectCandidate } from '../../../src/data-plane/pipeline/failover.ts';
import type { HttpResponseFact } from '@floway-dev/http';
import { asEntry, factSpace, run, type Deferred, type ManagedStream } from '@floway-dev/pipeline';
import type { ProtocolOutcome } from '@floway-dev/upstream';

type Request = { candidates: readonly Candidate[]; upstream: Candidate['upstream'] };
type Response = {
  http: HttpResponseFact | null;
  operation: ProtocolOutcome<never, string>;
  candidate: SelectedCandidate;
  extra: { stream: ManagedStream<string, never>; deferred: Deferred<void> };
};

const { defineStage, compose } = factSpace<Request, Response>();
const failover = defineStage({
  name: 'failover',
  through: {
    request: { needs: ['candidates'], provides: ['upstream'], consumes: ['candidates'] },
    response: { needs: ['http', 'operation'], provides: ['candidate'], consumes: [] },
  },
  async execute({ candidates, ...facts }, scope) {
    return await selectCandidate(candidates, scope, ({ upstream }) => scope.next({ ...facts, upstream }), answer => answer.operation);
  },
});

test.each([false, true])('aborts and discards whole losing answers while preserving the winner, with a discard panic: %s', async discardedPanics => {
  const losing = candidateFor('losing');
  const winning = candidateFor('winning');
  const discardPanic = new Error('losing stream failed during drain');
  const calls = new Map<string, AbortSignal>();
  const released: string[] = [];
  const ending = defineStage({
    name: 'attempt', request: { needs: ['upstream'] }, return: { provides: ['http', 'operation', 'extra'] },
    async execute({ upstream }, scope) {
      const { id } = upstream;
      calls.set(id, scope.signal);
      if (id === 'winning') expect(calls.get('losing')?.aborted).toBe(false);
      return {
        http: null,
        operation: id === 'winning' ? { kind: 'result', result: id } : { kind: 'error', source: 'upstream', error: id },
        extra: {
          stream: scope.createStream(async function* ({ signal }) {
            expect(signal.aborted).toBe(true);
            released.push(`${id}.stream`);
            if (id === 'losing' && discardedPanics) throw discardPanic;
            yield { ok: true, value: id };
          }),
          deferred: scope.createDeferred(async ({ signal }) => {
            await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
            released.push(`${id}.deferred`);
          }),
        },
      };
    },
  });
  const entry = asEntry(compose('select-candidate', {
    entry: ['candidates'], exit: ['http', 'operation', 'extra', 'candidate'], stages: [failover], ending,
  }));
  const host = hostFor({});
  const running = run(entry, { candidates: [losing, winning] }, host.options);
  const answer = await running.result;
  expect(calls.get('losing')?.aborted).toBe(true);
  expect(calls.get('winning')?.aborted).toBe(false);
  expect(answer.operation).toEqual({ kind: 'result', result: 'winning' });
  expect(answer.candidate).toEqual({ upstreamId: 'winning', model: 'public-model' });
  await host.settle();
  expect(released.sort()).toEqual(['losing.deferred', 'losing.stream']);
  host.controller.abort();
  running.discard(answer);
  await host.settle();
  expect(released.sort()).toEqual(['losing.deferred', 'losing.stream', 'winning.deferred', 'winning.stream']);
  expect(host.errors).toEqual(discardedPanics ? [discardPanic] : []);
});

test('retains the failure with the earliest absolute Retry-After time', async () => {
  const attempts = [
    { id: 'first', at: 1_000, retry: '5' },
    { id: 'second', at: 4_000, retry: '3' },
    { id: 'third', at: 4_500, retry: 'invalid' },
  ];
  const now = vi.spyOn(Date, 'now');
  const controller = new AbortController();
  const abandoned: unknown[] = [];
  const saved = new Map<Promise<unknown>, string>();
  try {
    const answer = await selectCandidate(attempts.map(({ id }) => candidateFor(id)), {
      signal: controller.signal,
      abort: call => abandoned.push(saved.get(call)),
      discard: answer => abandoned.push(answer.operation),
    }, ({ upstream }) => {
      const attempt = attempts.find(({ id }) => id === upstream.id)!;
      now.mockReturnValue(attempt.at);
      const http: HttpResponseFact = {
        status: 429, statusText: '', headers: [['Retry-After', attempt.retry]], body: null,
      };
      const call = Promise.resolve({ http, operation: attempt.id });
      saved.set(call, attempt.id);
      return call;
    }, () => ({ kind: 'error' }));
    expect(answer.operation).toBe('first');
    expect(abandoned).toEqual(['second', 'second', 'third', 'third']);
  } finally {
    now.mockRestore();
  }
});

test('interprets an asctime Retry-After in UTC independently of the runtime time zone', async () => {
  vi.stubEnv('TZ', 'Asia/Singapore');
  const now = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-06-01T00:00:00Z'));
  try {
    expect(new Date(Date.now()).getTimezoneOffset()).toBe(-480);
    const first = candidateFor('first');
    const second = candidateFor('second');
    const answer = await selectCandidate([first, second], {
      signal: new AbortController().signal,
      abort: () => {},
      discard: () => {},
    }, async ({ upstream }) => ({
      http: {
        status: 429, statusText: '', body: null,
        headers: [['Retry-After', upstream.id === first.upstream.id ? 'Mon Jun  1 00:00:30 2026' : '17']],
      },
      operation: { kind: 'error' as const },
    }), answer => answer.operation);
    expect(answer.candidate.upstreamId).toBe(second.upstream.id);
  } finally {
    now.mockRestore();
    vi.unstubAllEnvs();
  }
});

test('surfaces the original panic and relinquishes an earlier ordinary failure', async () => {
  const cause = new TypeError('candidate stage bug');
  const first = { http: null, operation: { kind: 'error' as const } };
  const call = Promise.resolve(first);
  const abort = vi.fn();
  const discard = vi.fn();
  const signal = new AbortController().signal;
  const start = ({ upstream }: Candidate) => upstream.id === 'failure' ? call : Promise.reject(cause);
  await expect(selectCandidate([candidateFor('failure'), candidateFor('panic')], { signal, abort, discard }, start, answer => answer.operation))
    .rejects.toBe(cause);
  expect(abort.mock.calls).toEqual([[call]]);
  expect(discard.mock.calls).toEqual([[first]]);
});

test('stops scheduling attempts after client cancellation', async () => {
  const controller = new AbortController();
  const abort = vi.fn();
  const discard = vi.fn();
  const start = vi.fn(async () => {
    controller.abort();
    return { http: null, operation: { kind: 'error' as const } };
  });
  const answer = await selectCandidate([candidateFor('open'), candidateFor('undialed')], {
    signal: controller.signal, abort, discard,
  }, start, response => response.operation);
  expect(start).toHaveBeenCalledOnce();
  expect(answer.candidate.upstreamId).toBe('open');
  expect(abort).not.toHaveBeenCalled();
  expect(discard).not.toHaveBeenCalled();
});
