import { hasNativeOpenAIResponsesCompactTarget, nativeOpenAIResponsesCompactRequest, nativeOpenAIResponsesCompactResponse } from './egress.ts';
import {
  collectOpenAIResponsesCompactionTurn,
  decryptOpenAIResponsesCompaction,
  dropOpenAIResponsesCompactionTurn,
  simulateOpenAIResponsesCompaction,
} from '../compaction.ts';
import { defineOpenAIResponsesStage, openAIResponsesCompactGenerationPayload } from '../pipeline-facts.ts';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesResultEx } from '@floway-dev/protocols/openai-responses';

const attemptRequest = [
  ...nativeOpenAIResponsesCompactRequest,
  'request.auth.userId',
  'request.auth.isAdmin',
  'request.auth.upstreamIds',
  'request.auth.randomizeUpstreams',
] as const;
const generationResponse = ['response.http', 'response.openaiResponses', 'response.usage?', 'response.performance?'] as const;

export const dispatchOpenAIResponsesCompact = defineOpenAIResponsesStage({
  name: 'openaiResponsesCompact.dispatch',
  request: { needs: attemptRequest },
  into: {
    native: {
      request: { needs: nativeOpenAIResponsesCompactRequest, provides: ['request.openaiResponsesCompact'], consumes: [] },
      response: { needs: nativeOpenAIResponsesCompactResponse, provides: [], consumes: [] },
    },
    generate: {
      request: {
        needs: attemptRequest,
        provides: ['request.openaiResponses'],
        consumes: ['request.openaiResponsesCompact'],
      },
      response: {
        needs: generationResponse,
        provides: ['response.http', 'response.openaiResponsesCompact'],
        consumes: ['response.openaiResponses'],
      },
    },
  },
  async execute(facts, scope) {
    const { 'request.openaiResponsesCompact': payload, ...request } = facts;
    const model = facts['provider.model'];
    const nativeKind = facts['provider.upstream'].kind;
    const generate = async (input: CanonicalOpenAIResponsesPayload) => {
      const call = scope.into.generate({ ...request, 'request.openaiResponses': input });
      const { 'response.openaiResponses': outcome, ...response } = await call;
      return await collectOpenAIResponsesCompactionTurn(call, response, outcome, scope);
    };
    const drop = (turn: Parameters<typeof dropOpenAIResponsesCompactionTurn>[0]) => dropOpenAIResponsesCompactionTurn(turn, scope);

    if (model.endpoints.openaiResponses === undefined || !hasNativeOpenAIResponsesCompactTarget(nativeKind)
      || model.enabledFlags.includes('openai-responses-compact-shim')) {
      const summaryRequest = openAIResponsesCompactGenerationPayload({ ...payload, model: model.id });
      const turn = await simulateOpenAIResponsesCompaction(summaryRequest, generate, drop, () =>
        scope.log.warn('Floway: OpenAI Responses compact shim returned no assistant text, retrying with the legacy summarizer'));
      return { ...turn.response, 'response.openaiResponsesCompact': turn.outcome };
    }

    const call = scope.into.native({
      ...facts,
      'request.openaiResponsesCompact': { ...payload, model: model.id },
    });
    const answer = await call;
    const { 'response.openaiResponsesCompact': outcome, ...response } = answer;
    if (outcome.kind === 'error' || !model.enabledFlags.includes('openai-responses-compact-decrypt')) return answer;

    const turn = await decryptOpenAIResponsesCompaction({
      call,
      response,
      outcome: { kind: 'result', result: outcome.result as unknown as OpenAIResponsesResultEx },
    }, model.id, generate, drop);
    return { ...turn.response, 'response.openaiResponsesCompact': turn.outcome };
  },
});
