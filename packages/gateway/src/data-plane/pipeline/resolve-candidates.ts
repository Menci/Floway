import { type HttpOutput, jsonHttpResponse } from './edge-http.ts';
import type { CandidatesRequest } from './failover.ts';
import { emptyUsageFacts, type UsageFacts, usageResponseKeys } from './observe-usage.ts';
import { renderedNow, type RenderFacts } from './render.ts';
import type { GatewayRouteFacts, GatewayServices, RouteCandidate } from './services.ts';
import { appendFailedUpstreams } from '../shared/failed-upstreams.ts';
import { defineStage } from '@floway-dev/pipeline';
import type { ModelKind } from '@floway-dev/protocols/common';

export interface ModelRequest extends GatewayRouteFacts { readonly 'request.model': string }
export type CandidateError = { readonly status: 400 | 404; readonly message: string; readonly model: string; readonly failedUpstreams: readonly string[] };

export const createResolveCandidates = <Candidate extends RouteCandidate = RouteCandidate, Request extends ModelRequest = ModelRequest>(options: {
  readonly kind: ModelKind;
  readonly sourceApi: string;
  readonly unsupportedMessage?: (model: string) => string;
  readonly select: (candidates: readonly RouteCandidate[], request: Request) => readonly Candidate[] | CandidateError;
  readonly errorBody?: (error: CandidateError) => unknown;
  readonly requestNeeds?: readonly string[];
}) => {
  type Down = Request & { readonly 'route.candidates': readonly Candidate[] };
  type Response = HttpOutput & UsageFacts & Partial<RenderFacts>;
  return defineStage<Request, Down, Response, Response, Pick<GatewayServices, 'providers'>>({
    name: 'resolveCandidates',
    through: {
      request: {
        needs: ['request.model', 'request.auth.user', 'request.route.upstreamIds', 'request.route.randomizeUpstreams', ...(options.requestNeeds ?? [])],
        consumes: [],
        provides: ['route.candidates'],
      },
      response: { needs: [], consumes: [], provides: [] },
    },
    return: { provides: ['response.http', 'response.render', ...usageResponseKeys] },
    execute: async (facts, next, env) => {
      const model = facts['request.model'];
      const { candidates, sawModel, failedUpstreams } = await env.services.providers.enumerate(facts, model, options.kind);
      const selection = options.select(candidates, facts);
      if (!('status' in selection) && selection.length > 0) {
        const request: Down & CandidatesRequest = { ...facts, 'route.candidates': selection };
        return await next(request);
      }
      const error: CandidateError = 'status' in selection ? selection : {
        model,
        failedUpstreams,
        status: sawModel ? 400 : 404,
        message: appendFailedUpstreams(sawModel
          ? options.unsupportedMessage?.(model) ?? `Model ${model} does not support the ${options.sourceApi} endpoint.`
          : `Model ${model} is not available on any configured upstream.`, failedUpstreams),
      };
      const body = options.errorBody === undefined ? { error: { message: error.message, type: 'api_error' } } : options.errorBody(error);
      return { ...emptyUsageFacts(env), ...renderedNow(env, { kind: 'completed' }), 'response.http': jsonHttpResponse(error.status, body, env.clock()) };
    },
  });
};
