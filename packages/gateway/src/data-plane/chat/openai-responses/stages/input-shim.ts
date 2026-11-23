import { type ResponsesBodyBack, type ResponsesBodyFacts, responsesBodyRequest } from './facts.ts';
import { answerKeys, gatewayAnswer } from '../../../pipeline/answer.ts';
import { jsonHttpResponse } from '../../../pipeline/edge-http.ts';
import { ResponsesInputError, responsesInputErrorBody } from '../errors.ts';
import { defineStage } from '@floway-dev/pipeline';
import type { CanonicalOpenAIResponsesInputItem } from '@floway-dev/protocols/openai-responses';
import type { FlagId } from '@floway-dev/provider';

export const responsesInputShim = (
  name: string,
  flag: FlagId,
  lower: (item: CanonicalOpenAIResponsesInputItem, index: number) => CanonicalOpenAIResponsesInputItem,
) => defineStage<ResponsesBodyFacts, ResponsesBodyFacts, ResponsesBodyBack, ResponsesBodyBack>({
  name,
  through: { request: responsesBodyRequest, response: { needs: [], consumes: [], provides: [] } },
  return: { provides: [...answerKeys, 'response.openaiResponses'] },
  execute: async (facts, next, env) => {
    const payload = facts['request.openaiResponses'];
    if (facts['route.targetApi'] === 'openaiResponses' && !facts['route.candidate'].providerModel.enabledFlags.includes(flag)) {
      return await next(facts);
    }

    let input: CanonicalOpenAIResponsesInputItem[];
    try {
      input = payload.input.map(lower);
    } catch (error) {
      if (!(error instanceof ResponsesInputError)) throw error;
      return {
        ...gatewayAnswer(env, jsonHttpResponse(400, responsesInputErrorBody(error.details), env.clock())),
        'response.openaiResponses': undefined,
      };
    }
    return await next({ ...facts, 'request.openaiResponses': { ...payload, input } });
  },
});
