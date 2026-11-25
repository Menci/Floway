import { openAIResponsesBody } from './body.ts';
import { completeOpenAIResponsesClientOutput } from './client-output.ts';
import { collectOpenAIResponses } from './collect-response.ts';
import { renderOpenAIResponses } from './encode-response.ts';
import { openAIResponsesError } from './error.ts';
import { openAIResponsesBodyEntry, openAIResponsesExit, openAIResponsesFactSpace, type OpenAIResponsesAction } from './facts.ts';
import { hydrateOpenAIResponsesItems } from './hydrate-items.ts';
import { normalizeOpenAIResponsesUpstreamError } from './normalize-upstream-error.ts';
import { parseOpenAIResponsesRequest } from './parse-request.ts';
import { serializeOpenAIResponsesStreamItems } from './serialize-stream-items.ts';
import type { OpenAIResponsesServices } from './services.ts';
import { servesOpenAIResponses } from './target.ts';
import { discoverCandidates } from '../../../pipeline/discover-candidates.ts';
import { encodeResponse } from '../../../pipeline/encode-response.ts';
import { httpEntry } from '../../../pipeline/facts.ts';
import { failover } from '../../../pipeline/failover.ts';
import { requestBody } from '../../../pipeline/request-body.ts';
import { stripFlowayAuth } from '../../../pipeline/strip-floway-auth.ts';
import { appendFailedUpstreams } from '../../../shared/failed-upstreams.ts';
import { normalizeDamagedUpstreamResponse } from '../../../shared/normalize-damaged-upstream-response.ts';
import { prepareChatAffinity } from '../../pipeline/affinity.ts';
import { analyzeOpenAIResponsesAffinity } from '../affinity/ingress.ts';

const { compose, defineStage } = openAIResponsesFactSpace<OpenAIResponsesServices>();

const openAIResponsesRequestEntry = [
  ...httpEntry, 'request.openaiResponses', 'request.openaiResponsesAction', 'request.delivery', 'serve.model', 'request.ws.responseId?',
] as const;

const enterBody = defineStage({
  name: 'openaiResponses.enter-body',
  request: { needs: openAIResponsesBodyEntry },
  into: {
    body: {
      request: { needs: openAIResponsesBodyEntry, provides: [], consumes: [] },
      response: { needs: openAIResponsesExit, provides: [], consumes: [] },
    },
  },
  async execute(facts, scope) {
    return await scope.into.body(facts);
  },
});

const candidatesUnavailable = (model: string, { sawModel, failedUpstreams }: {
  readonly sawModel: boolean;
  readonly failedUpstreams: readonly string[];
}) => {
  const message = sawModel
    ? `Model ${model} does not support the /responses endpoint.`
    : `Model ${model} is not available on any configured upstream.`;
  return openAIResponsesError(sawModel ? 400 : 404, {
    error: { message: appendFailedUpstreams(message, failedUpstreams), type: 'invalid_request_error' },
  });
};

const attempt = failover('response.openaiResponses', candidatesUnavailable, servesOpenAIResponses,
  prepareChatAffinity('openaiResponses', analyzeOpenAIResponsesAffinity, message =>
    openAIResponsesError(400, {
      error: { message, type: 'invalid_request_error', param: 'input', code: 'responses_item_routing_unavailable' },
    })));

export const openAIResponsesClientPipeline = compose('openaiResponses.client', {
  entry: openAIResponsesRequestEntry,
  exit: openAIResponsesExit,
  stages: [
    stripFlowayAuth,
    hydrateOpenAIResponsesItems,
    discoverCandidates('chat'),
    normalizeOpenAIResponsesUpstreamError,
    normalizeDamagedUpstreamResponse('response.openaiResponses'),
    attempt,
    completeOpenAIResponsesClientOutput,
    serializeOpenAIResponsesStreamItems,
  ],
  ending: enterBody,
  targets: { body: openAIResponsesBody },
});

const enterClient = defineStage({
  name: 'openaiResponses.enter-client',
  request: { needs: openAIResponsesRequestEntry },
  into: {
    client: {
      request: { needs: openAIResponsesRequestEntry, provides: [], consumes: [] },
      response: { needs: openAIResponsesExit, provides: [], consumes: [] },
    },
  },
  async execute(facts, scope) {
    return await scope.into.client(facts);
  },
});

export const openAIResponsesHttpPipeline = (action: OpenAIResponsesAction) => compose(
  action === 'generate' ? 'openaiResponses.ingress' : 'openaiResponses.compact-ingress',
  {
    entry: [...httpEntry, 'request.ws.responseId?'],
    exit: ['response.http'],
    stages: [
      requestBody,
      parseOpenAIResponsesRequest(action),
      encodeResponse('response.openaiResponses', renderOpenAIResponses(action)),
      collectOpenAIResponses,
    ],
    ending: enterClient,
    targets: { client: openAIResponsesClientPipeline },
  },
);
