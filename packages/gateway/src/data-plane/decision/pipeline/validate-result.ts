import { gatewayFactSpace } from '../../pipeline/facts.ts';
import { move } from '@floway-dev/pipeline';

const { defineStage } = gatewayFactSpace<{}>();

export const validateDecisionResult = defineStage({
  name: 'decision.validate-result',
  through: {
    request: { needs: ['request.decision'], provides: [], consumes: [] },
    response: { needs: ['response.decision'], provides: ['response.decision'], consumes: [] },
  },
  async execute(facts, scope) {
    const response = await scope.next(facts);
    const outcome = response['response.decision'];
    if (outcome.kind !== 'result' || facts['request.decision'].sourceProtocol !== 'typesafe-systemone') return response;

    const refusal = outcome.result.answers.find(answer => answer.type === 'refusal');
    if (refusal === undefined) return response;
    return {
      ...response,
      'response.decision': move({
        kind: 'error',
        source: 'upstream',
        error: outcome.result.raw,
        cause: new Error(`answers.${refusal.name} is a refusal, which System One cannot express`),
      }),
    };
  },
});
