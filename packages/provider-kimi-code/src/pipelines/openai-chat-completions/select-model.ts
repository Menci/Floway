import { defineStage } from '../facts.ts';
import { invalidModel, selectOpenAIModel } from '../select-model.ts';

export const selectModel = defineStage({
  name: 'kimi-code.openaiChatCompletions.select-model',
  through: {
    request: { needs: ['request.openaiChatCompletions', 'provider.model'], provides: ['request.openaiChatCompletions'], consumes: [] },
    response: { needs: ['response.openaiChatCompletions'], provides: ['response.openaiChatCompletions'], consumes: [] },
  },
  return: { provides: ['response.http', 'response.openaiChatCompletions'] },
  async execute(facts, scope) {
    const body = facts['request.openaiChatCompletions'];
    const selection = selectOpenAIModel(facts['provider.model'], body.service_tier);
    if (!selection.ok) {
      const { http, outcome } = invalidModel(selection.error, false);
      return { 'response.http': http, 'response.openaiChatCompletions': outcome };
    }

    const { modelId, tier } = selection.value;
    const answer = await scope.next({
      ...facts,
      'request.openaiChatCompletions': { ...body, model: modelId, stream: true, ...(tier !== undefined && { service_tier: tier }) },
    });
    const outcome = answer['response.openaiChatCompletions'];
    if (outcome.kind !== 'stream' || tier === undefined) return answer;
    // Kimi may omit the service tier when accepting a priority request.
    // https://www.kimi.com/code/docs/en/kimi-code/models.html
    // https://developers.openai.com/api/docs/guides/priority-processing
    const stream = scope.wrapStream(outcome.stream, async function* (source, producer) {
      for await (const item of producer.read(source)) {
        yield item.ok ? { ok: true, value: { ...item.value, service_tier: tier } } : item;
      }
    });
    return { ...answer, 'response.openaiChatCompletions': { kind: 'stream', stream } };
  },
});
