import parseHttpDate from 'http-dates';

import { mergeBillableCalls, type UsageFacts } from './observe-usage.ts';
import type { RouteCandidate } from './services.ts';
import { isUpstreamTransportError } from '../../dial/transport-error.ts';
import type { HttpResponseFacts } from '@floway-dev/http';
import { defineStage, type ErrorSnapshot, isManagedStream, type ManagedStream, snapshotError } from '@floway-dev/pipeline';
import { isAbortError } from '@floway-dev/provider';

export interface CandidateRequest { readonly 'route.candidate': RouteCandidate }
export interface CandidatesRequest { readonly 'route.candidates': readonly RouteCandidate[] }
export interface AttemptResponse extends UsageFacts {
  readonly 'response.http': HttpResponseFacts;
  readonly 'response.events'?: ManagedStream<unknown>;
  readonly 'response.attempt.status'?: number;
}

export interface SelectedAttemptResponse extends AttemptResponse {
  readonly 'response.route.candidate': RouteCandidate;
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

const closeFailure = async (result: AttemptResponse | undefined, log: (error: ErrorSnapshot) => void): Promise<void> => {
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

export const failover = defineStage<CandidatesRequest, CandidateRequest, AttemptResponse, SelectedAttemptResponse>({
  name: 'failover',
  through: {
    request: { needs: ['route.candidates'], consumes: ['route.candidates'], provides: ['route.candidate'] },
    response: { needs: ['response.http', 'response.usage.billable'], consumes: [], provides: ['response.usage.billable', 'response.usage.selected', 'response.route.candidate'] },
  },
  execute: async ({ 'route.candidates': candidates, ...facts }, next, env) => {
    let selected: { readonly response: AttemptResponse; readonly candidate: RouteCandidate } | undefined;
    let earliestRetryTime: number | null = null;
    let lastTransportError: Error | undefined;
    const billings: UsageFacts['response.usage.billable'][] = [];
    const discard = (response: AttemptResponse | undefined) => closeFailure(response, error => {
      env.log.warn('Floway: failed to cancel a discarded upstream response', { error: { ...error } });
    });
    const answer = (response: AttemptResponse, candidate: RouteCandidate): SelectedAttemptResponse => ({
      ...response,
      'response.route.candidate': candidate,
      'response.usage.selected': response['response.usage.billable'],
      'response.usage.billable': env.defer('all attempt billing', mergeBillableCalls(billings)),
    });
    try {
      for (const candidate of candidates) {
        env.signal.throwIfAborted();
        let response: AttemptResponse;
        try {
          response = await next({ ...facts, 'route.candidate': candidate });
        } catch (error) {
          if (env.signal.aborted || isAbortError(error) || !isUpstreamTransportError(error)) throw error;
          lastTransportError = error;
          continue;
        }
        billings.push(response['response.usage.billable']);
        if (isSuccess(response['response.attempt.status'] ?? response['response.http'].status)) return answer(response, candidate);

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
      return answer(terminal.response, terminal.candidate);
    } finally {
      await discard(selected?.response);
    }
  },
});
