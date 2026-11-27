import { collectOpenAIResponsesCompactionTurn, decryptOpenAIResponsesCompaction, dropOpenAIResponsesCompactionTurn, simulateOpenAIResponsesCompaction, type OpenAIResponsesCompactionTurn } from './compaction.ts';
import { defineStage } from './facts.ts';
import { compactGenerationPayload } from './generation-payload.ts';
import { openaiResponsesCompactTargets } from './providers.ts';
import { openAIResponsesDelivery } from '../../chat/openai-responses/pipeline/parse.ts';
import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';

export const nativeOpenAIResponsesCompactRequest = ['http', 'upstream', 'model', 'aliasRules', 'openaiResponsesCompact'] as const;
export const nativeOpenAIResponsesCompactResponse = ['http', 'openaiResponsesCompact', 'usage?'] as const;

const attemptRequest = [...nativeOpenAIResponsesCompactRequest, 'requestedModel', 'serve.startedAt', 'chat.target'] as const;

export const dispatchOpenAIResponsesCompact = defineStage({
  name: 'openaiResponsesCompact.dispatch',
  request: { needs: attemptRequest },
  into: {
    native: {
      request: { needs: nativeOpenAIResponsesCompactRequest, provides: ['openaiResponsesCompact'], consumes: [] },
      response: { needs: nativeOpenAIResponsesCompactResponse, provides: [], consumes: [] },
    },
    generate: {
      request: {
        needs: attemptRequest, provides: ['delivery', 'openaiResponses'],
        consumes: ['openaiResponsesCompact', 'ws.message', 'ws.eventId', 'ws.responseId'],
      },
      response: {
        needs: ['http', 'openaiResponses', 'usage?', 'usageModelKey?'],
        provides: ['http', 'openaiResponsesCompact'], consumes: ['openaiResponses', 'usageModelKey'],
      },
    },
  },
  async execute(facts, scope) {
    const { openaiResponsesCompact: payload, model, ...request } = facts;
    const generate = async (input: CanonicalOpenAIResponsesPayload) => {
      const call = scope.into.generate({
        ...request, model, openaiResponses: input, delivery: openAIResponsesDelivery(false, facts['serve.startedAt'], false),
      });
      return await collectOpenAIResponsesCompactionTurn(call, await call, scope);
    };
    const drop = (turn: OpenAIResponsesCompactionTurn) => dropOpenAIResponsesCompactionTurn(turn, scope);
    const result = ({ response, outcome }: OpenAIResponsesCompactionTurn) => {
      const { usageModelKey: _usageModelKey, ...answer } = response;
      return { ...answer, openaiResponsesCompact: outcome };
    };

    if (model.endpoints.openaiResponses === undefined || !Object.hasOwn(openaiResponsesCompactTargets, facts.upstream.kind)
      || model.enabledFlags.includes('openai-responses-compact-shim')) {
      const summaryRequest = compactGenerationPayload({ ...payload, model: model.id });
      const turn = await simulateOpenAIResponsesCompaction(summaryRequest, generate, drop, () =>
        scope.log.warn('Floway: OpenAI Responses compact shim returned no assistant text, retrying with the legacy summarizer'));
      return result(turn);
    }

    const call = scope.into.native({ ...facts, openaiResponsesCompact: { ...payload, model: model.id } });
    const answer = await call;
    const { openaiResponsesCompact: outcome, ...response } = answer;
    if (outcome.kind === 'error' || !model.enabledFlags.includes('openai-responses-compact-decrypt')) return answer;
    return result(await decryptOpenAIResponsesCompaction({ call, answer, response, outcome }, model.id, generate, drop));
  },
});
