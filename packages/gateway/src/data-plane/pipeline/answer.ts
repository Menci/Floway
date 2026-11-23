import { emptyUsageFacts, usageResponseKeys } from './observe-usage.ts';
import { renderedNow } from './render.ts';
import type { HttpResponseFacts } from '@floway-dev/http';
import type { StageEnv } from '@floway-dev/pipeline';
import type { PerformanceOperation } from '@floway-dev/provider';

export type AnswerSource = 'upstream' | 'gateway';

export interface AnswerFacts {
  readonly 'response.source': AnswerSource;
  readonly 'response.performance.operation'?: PerformanceOperation;
}

export const answerKeys = ['response.http', 'response.source', 'response.render', ...usageResponseKeys] as const;

export const gatewayAnswer = <Extra extends object = {}>(env: Pick<StageEnv, 'defer'>, http: HttpResponseFacts, extra?: Extra) => ({
  ...extra,
  ...emptyUsageFacts(env),
  ...renderedNow(env, { kind: 'completed' }),
  'response.http': http,
  'response.source': 'gateway' as const,
});
