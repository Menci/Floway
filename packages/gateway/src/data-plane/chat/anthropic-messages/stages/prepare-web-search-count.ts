import type { AnthropicMessagesTargetRequest } from './facts.ts';
import { invalidWebSearchRequest, prepareAnthropicMessagesWebSearchForTarget } from './web-search-protocol.ts';
import { answerKeys, gatewayAnswer } from '../../../pipeline/answer.ts';
import { jsonHttpResponse } from '../../../pipeline/edge-http.ts';
import type { AnthropicMessagesCountBodyOutput } from '../body.ts';
import { defineStage } from '@floway-dev/pipeline';

type Request = AnthropicMessagesTargetRequest;
type Response = AnthropicMessagesCountBodyOutput;

export const prepareWebSearchCount = defineStage<Request, Request, Response, Response>({
  name: 'prepareWebSearchCount',
  through: {
    request: {
      needs: ['request.anthropicMessages', 'route.candidate', 'route.targetApi'],
      consumes: [],
      provides: ['request.anthropicMessages'],
    },
    response: { needs: [], consumes: [], provides: [] },
  },
  return: { provides: [...answerKeys, 'response.targetApi'] },
  execute: async (facts, next, env) => {
    const prepared = prepareAnthropicMessagesWebSearchForTarget(facts);
    if (prepared.type === 'invalid-request') {
      return {
        ...gatewayAnswer(env, jsonHttpResponse(400, invalidWebSearchRequest(prepared.message), env.clock())),
        'response.targetApi': 'anthropicMessages',
      };
    }
    return await next({ ...facts, 'request.anthropicMessages': prepared.payload });
  },
});
