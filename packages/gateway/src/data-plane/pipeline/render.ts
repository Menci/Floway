import type { HttpOutput } from './edge-http.ts';
import type { HttpResponseFacts } from '@floway-dev/http';
import { type Deferred, type ErrorSnapshot, type Scope, snapshotError } from '@floway-dev/pipeline';

export type RenderOutcome = { readonly kind: 'completed' }
  | { readonly kind: 'cancelled' }
  | {
    readonly kind: 'failed';
    readonly reason: 'protocol-error' | 'premature-eof' | 'source-error' | 'collect-error';
    readonly error?: ErrorSnapshot;
  };

export interface RenderFacts { readonly 'response.render': Deferred<RenderOutcome> }

type FailedRender = Extract<RenderOutcome, { kind: 'failed' }>;

export const renderedNow = (scope: Pick<Scope, 'defer'>, outcome: RenderOutcome): RenderFacts => ({
  'response.render': scope.defer('render outcome', Promise.resolve(outcome)),
});

export const localHttpAnswer = (scope: Pick<Scope, 'defer'>, http: HttpResponseFacts): HttpOutput & RenderFacts => ({
  'response.http': http,
  ...renderedNow(scope, { kind: 'completed' }),
});

export const failedRender = (reason: FailedRender['reason'], error?: unknown): FailedRender => ({
  kind: 'failed', reason, ...(error === undefined ? {} : { error: snapshotError(error) }),
});
