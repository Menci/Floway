import { decisionError } from './parse.ts';
import { defineStage } from '../pipeline/facts.ts';

const response = ['response.decision'] as const;

export const validateDecisionResponse = defineStage({
  name: 'decision.validate-response',
  through: {
    request: { needs: ['request.decision'], provides: [], consumes: [] },
    response: { needs: response, provides: response, consumes: [] },
  },
  async execute(facts, scope) {
    const answer = await scope.next(facts);
    const outcome = answer['response.decision'];
    if (outcome.kind !== 'result' || outcome.result instanceof Uint8Array
      || facts['request.decision'].sourceProtocol !== 'typesafe-systemone') return answer;
    const refusal = outcome.result.answers.find(item => item.type === 'refusal');
    if (refusal === undefined) return answer;
    return {
      ...answer,
      'response.decision': {
        kind: 'error',
        source: 'upstream',
        error: decisionError(`answers.${refusal.name} is a refusal, which System One cannot express`),
      },
    };
  },
});
