import { type ResponsesBodyBack, type ResponsesBodyFacts, responsesBodyRequest } from './facts.ts';
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
  return: { provides: ['response.http', 'response.openaiResponses'] },
  execute: async (facts, scope) => {
    const payload = facts['request.openaiResponses'];
    if (facts['route.targetApi'] === 'openaiResponses' && !facts['route.candidate'].providerModel.enabledFlags.includes(flag)) {
      return await scope.next(facts);
    }

    let input: CanonicalOpenAIResponsesInputItem[];
    try {
      input = payload.input.map(lower);
    } catch (error) {
      if (!(error instanceof ResponsesInputError)) throw error;
      const body = responsesInputErrorBody(error.details);
      return {
        'response.http': jsonHttpResponse(400, body, scope.clock()),
        'response.openaiResponses': { kind: 'error', source: 'local', error: body },
      };
    }
    return await scope.next({ ...facts, 'request.openaiResponses': { ...payload, input } });
  },
});
