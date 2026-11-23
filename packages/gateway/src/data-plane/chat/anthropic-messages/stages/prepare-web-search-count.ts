import type { AnthropicMessagesTargetRequest } from './facts.ts';
import { invalidWebSearchRequest, prepareAnthropicMessagesWebSearchForTarget } from './web-search-protocol.ts';
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
  return: { provides: ['response.http', 'response.anthropicMessagesCountTokens'] },
  execute: async (facts, scope) => {
    const prepared = prepareAnthropicMessagesWebSearchForTarget(facts);
    if (prepared.type === 'invalid-request') {
      const error = invalidWebSearchRequest(prepared.message);
      return {
        'response.http': jsonHttpResponse(400, error, scope.clock()),
        'response.anthropicMessagesCountTokens': { kind: 'error', source: 'local', error },
      };
    }
    return await scope.next({ ...facts, 'request.anthropicMessages': prepared.payload });
  },
});
