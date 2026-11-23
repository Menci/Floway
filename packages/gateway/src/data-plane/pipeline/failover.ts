import parseHttpDate from 'http-dates';

import type { AnswerFacts } from './answer.ts';
import { mergeBillableCalls, type UsageFacts } from './observe-usage.ts';
import type { RouteCandidate } from './services.ts';
import { isUpstreamTransportError } from '../../dial/transport-error.ts';
import type { HttpResponseFacts } from '@floway-dev/http';
import { defineStage, type ErrorSnapshot, isManagedStream, type ManagedStream, snapshotError, type StageEnv } from '@floway-dev/pipeline';
import { isAbortError } from '@floway-dev/provider';

export interface CandidateRequest { readonly 'route.candidate': RouteCandidate }
export interface CandidatesRequest { readonly 'route.candidates': readonly RouteCandidate[] }
interface HttpAttempt extends AnswerFacts {
  readonly 'response.http': HttpResponseFacts;
  readonly 'response.events'?: ManagedStream<unknown>;
}

interface SelectedHttpAttempt extends HttpAttempt {
  readonly 'response.route.candidate': RouteCandidate;
}

export interface AttemptResponse extends HttpAttempt, UsageFacts {}

export interface SelectedAttemptResponse extends AttemptResponse, SelectedHttpAttempt {
  readonly 'response.usage.selected': UsageFacts['response.usage.billable'];
}

const isSuccess = (status: number): boolean => status >= 200 && status < 300;

// https://www.rfc-editor.org/rfc/rfc9110.html#section-10.2.3
const retryTime = (http: HttpResponseFacts): number | null => {
  const header = http.headers.find(([name]) => name.toLowerCase() === 'retry-after')?.[1];
  const value = typeof header === 'string' ? header.trim() : header?.reveal().trim();
  if (!value) return null;
  const now = Date.now();
  if (/^\d+(?:\.\d+)?$/.test(value)) {
    const time = now + Number(value) * 1000;
    return Number.isFinite(time) ? time : null;
  }
  try {
    return Math.max(now, parseHttpDate(value).getTime());
  } catch {
    return null;
  }
};

const closeFailure = async (result: HttpAttempt | undefined, log: (error: ErrorSnapshot) => void): Promise<void> => {
  if (result === undefined) return;
  const streams = new Set([result['response.http'].body, result['response.events']].filter(isManagedStream));
  const closed = await Promise.allSettled([...streams].map(stream => stream.close()));
  for (const outcome of closed) {
    if (outcome.status === 'rejected') {
      console.warn('Floway: failed to cancel a discarded upstream response', outcome.reason);
      log(snapshotError(outcome.reason));
    }
  }
};

const selectAttempt = async <Response extends HttpAttempt>(
  candidates: readonly RouteCandidate[],
  invoke: (candidate: RouteCandidate) => Promise<Response>,
  env: Pick<StageEnv, 'signal' | 'log'>,
) => {
  let selected: { readonly response: Response; readonly candidate: RouteCandidate } | undefined;
  let earliestRetryTime: number | null = null;
  let lastTransportError: Error | undefined;
  const discard = (response: Response | undefined) => closeFailure(response, error => {
    env.log.warn('Floway: failed to cancel a discarded upstream response', { error: { ...error } });
  });
  try {
    for (const candidate of candidates) {
      env.signal.throwIfAborted();
      let response: Response;
      try {
        response = await invoke(candidate);
      } catch (error) {
        if (env.signal.aborted || isAbortError(error) || !isUpstreamTransportError(error)) throw error;
        lastTransportError = error;
        continue;
      }
      if (isSuccess(response['response.http'].status)) return { response, candidate };

      lastTransportError = undefined;
      const time = retryTime(response['response.http']);
      if (earliestRetryTime !== null && (time === null || time >= earliestRetryTime)) {
        await discard(response);
        continue;
      }
      await discard(selected?.response);
      selected = { response, candidate };
      earliestRetryTime = time;
    }

    if (earliestRetryTime === null && lastTransportError !== undefined) throw lastTransportError;
    if (selected === undefined) throw new Error('invariant broken: failover exhausted candidates with neither success nor failure');
    const terminal = selected;
    selected = undefined;
    return terminal;
  } finally {
    await discard(selected?.response);
  }
};

const request = { needs: ['route.candidates'], consumes: ['route.candidates'], provides: ['route.candidate'] };
const responseNeeds = ['response.http', 'response.source'];

export const failover = defineStage<CandidatesRequest, CandidateRequest, AttemptResponse, SelectedAttemptResponse>({
  name: 'failover',
  through: {
    request,
    response: { needs: [...responseNeeds, 'response.usage.billable'], consumes: [], provides: ['response.usage.billable', 'response.usage.selected', 'response.route.candidate'] },
  },
  execute: async ({ 'route.candidates': candidates, ...facts }, next, env) => {
    const billings: UsageFacts['response.usage.billable'][] = [];
    const { response, candidate } = await selectAttempt(candidates, async candidate => {
      const attempt = await next({ ...facts, 'route.candidate': candidate });
      billings.push(attempt['response.usage.billable']);
      return attempt;
    }, env);
    return {
      ...response,
      'response.route.candidate': candidate,
      'response.usage.selected': response['response.usage.billable'],
      'response.usage.billable': env.defer('all attempt billing', mergeBillableCalls(billings)),
    };
  },
});

export const failoverHttp = defineStage<CandidatesRequest, CandidateRequest, HttpAttempt, SelectedHttpAttempt>({
  name: 'failover',
  through: {
    request,
    response: { needs: responseNeeds, consumes: [], provides: ['response.route.candidate'] },
  },
  execute: async ({ 'route.candidates': candidates, ...facts }, next, env) => {
    const { response, candidate } = await selectAttempt(candidates, candidate => next({ ...facts, 'route.candidate': candidate }), env);
    return { ...response, 'response.route.candidate': candidate };
  },
});
