import { type HttpOutput, httpRetryTime } from './edge-http.ts';
import type { RouteCandidate } from './services.ts';
import { defineStage, isManagedStream } from '@floway-dev/pipeline';

export interface CandidateRequest { readonly 'route.candidate': RouteCandidate }
export interface CandidatesRequest { readonly 'route.candidates': readonly RouteCandidate[] }

const closeFailure = async (response: HttpOutput | undefined): Promise<void> => {
  const body = response?.['response.http'].body;
  if (isManagedStream(body)) await body.close();
};

export const createFailover = <OutcomeKey extends string>(outcomeKey: OutcomeKey) => {
  type Response = HttpOutput & Readonly<Record<OutcomeKey, { readonly kind: string }>>;
  return defineStage<CandidatesRequest, CandidateRequest, Response, Response>({
    name: 'failover',
    through: {
      request: { needs: ['route.candidates'], consumes: ['route.candidates'], provides: ['route.candidate'] },
      response: { needs: ['response.http', outcomeKey], consumes: [], provides: [] },
    },
    execute: async ({ 'route.candidates': candidates, ...facts }, scope) => {
      let selected: Response | undefined;
      let earliestRetryTime: number | null = null;
      let lastTransport: Response | undefined;
      for (const candidate of candidates) {
        const response = await scope.next({ ...facts, 'route.candidate': candidate });
        if (response[outcomeKey].kind !== 'error') {
          await closeFailure(selected);
          await closeFailure(lastTransport);
          return response;
        }
        const http = response['response.http'];
        await closeFailure(lastTransport);
        if (http.transportError !== undefined) {
          lastTransport = response;
          continue;
        }
        lastTransport = undefined;
        const time = httpRetryTime(http);
        if (earliestRetryTime !== null && (time === null || time >= earliestRetryTime)) {
          await closeFailure(response);
          continue;
        }
        await closeFailure(selected);
        selected = response;
        earliestRetryTime = time;
      }
      if (earliestRetryTime === null && lastTransport !== undefined) {
        await closeFailure(selected);
        return lastTransport;
      }
      await closeFailure(lastTransport);
      if (selected === undefined) throw new Error('Failover requires at least one route candidate');
      return selected;
    },
  });
};
