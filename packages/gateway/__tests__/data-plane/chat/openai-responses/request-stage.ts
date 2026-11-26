import { compose, defineStage } from '../../../../src/data-plane/pipeline/facts.ts';
import type { GatewayServices } from '../../../../src/data-plane/pipeline/services.ts';
import { run } from '@floway-dev/pipeline';
import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';
import { toProviderModelFact, type FlagId } from '@floway-dev/provider';
import { stubProviderModel } from '@floway-dev/test-utils';

export const observeResponsesRequest = async (
  stage: ReturnType<typeof defineStage>,
  payload: CanonicalOpenAIResponsesPayload,
  enabledFlags: ReadonlySet<FlagId>,
  native = true,
) => {
  let seen: CanonicalOpenAIResponsesPayload | undefined;
  const exit = ['response.http', 'response.openaiResponses'] as const;
  const ending = defineStage({
    name: 'test.observe-request',
    request: { needs: ['request.openaiResponses'] },
    return: { provides: exit },
    async execute(facts) {
      seen = facts['request.openaiResponses'];
      return {
        'response.http': null,
        'response.openaiResponses': {
          kind: 'result', result: {
            id: 'test', object: 'response', model: payload.model, status: 'completed', output: [], error: null, incomplete_details: null,
          },
        },
      };
    },
  });
  const pipeline = compose('responses-request-test', {
    entry: ['request.openaiResponses', 'provider.model'], exit, stages: [stage], ending,
  });
  const controller = new AbortController();
  const running = run(pipeline, {
    'request.openaiResponses': payload,
    'provider.model': toProviderModelFact(stubProviderModel({
      enabledFlags, endpoints: native ? { openaiResponses: {} } : { anthropicMessages: {} },
    })),
  }, { services: {} as GatewayServices, signal: controller.signal, waitUntil: () => {} });
  const answer = await running.result;
  controller.abort();
  await running.done;
  return { seen, answer };
};
