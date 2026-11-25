import { defineStage } from '../facts.ts';
import { invalidModel, selectOpenAIModel } from '../select-model.ts';

export const selectModel = defineStage({
  name: 'kimi-code.openaiResponses.select-model',
  through: {
    request: { needs: ['request.openaiResponses', 'provider.model'], provides: ['request.openaiResponses'], consumes: [] },
    response: { needs: ['response.openaiResponses'], provides: ['response.openaiResponses'], consumes: [] },
  },
  return: { provides: ['response.http', 'response.openaiResponses'] },
  async execute(facts, scope) {
    const body = facts['request.openaiResponses'];
    const selection = selectOpenAIModel(facts['provider.model'], body.service_tier);
    if (!selection.ok) {
      const { http, outcome } = invalidModel(selection.error, false);
      return { 'response.http': http, 'response.openaiResponses': outcome };
    }

    const { modelId, tier } = selection.value;
    const answer = await scope.next({
      ...facts,
      'request.openaiResponses': { ...body, model: modelId, stream: true, ...(tier !== undefined && { service_tier: tier }) },
    });
    const outcome = answer['response.openaiResponses'];
    if (outcome.kind !== 'stream' || tier === undefined) return answer;
    // https://www.kimi.com/code/docs/en/kimi-code/models.html
    // https://developers.openai.com/api/docs/guides/priority-processing
    const stream = scope.wrapStream(outcome.stream, async function* (source, producer) {
      for await (const item of producer.read(source)) {
        if (item.ok && 'response' in item.value) {
          const event = item.value;
          yield { ok: true, value: { ...event, response: { ...event.response, service_tier: tier } } };
        } else {
          yield item;
        }
      }
    });
    return { ...answer, 'response.openaiResponses': { kind: 'stream', stream } };
  },
});
