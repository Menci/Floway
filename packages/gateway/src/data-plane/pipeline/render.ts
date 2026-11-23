import { type Deferred, type ErrorSnapshot, snapshotError, type StageEnv } from '@floway-dev/pipeline';

export type RenderOutcome = { readonly kind: 'completed' }
  | { readonly kind: 'cancelled' }
  | {
    readonly kind: 'failed';
    readonly reason: 'protocol-error' | 'premature-eof' | 'source-error' | 'collect-error';
    readonly error?: ErrorSnapshot;
  };

export interface RenderFacts { readonly 'response.render': Deferred<RenderOutcome> }

type FailedRender = Extract<RenderOutcome, { kind: 'failed' }>;

export const renderedNow = (env: Pick<StageEnv, 'defer'>, outcome: RenderOutcome): RenderFacts => ({
  'response.render': env.defer('render outcome', Promise.resolve(outcome)),
});

export const failedRender = (reason: FailedRender['reason'], error?: unknown): FailedRender => ({
  kind: 'failed', reason, ...(error === undefined ? {} : { error: snapshotError(error) }),
});
