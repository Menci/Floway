import { defineStage } from '../facts.ts';
import { invalidModel, selectAnthropicModel } from '../select-model.ts';

export const selectModel = defineStage({
  name: 'kimi-code.anthropicMessages.select-model',
  through: {
    request: { needs: ['request.anthropicMessages', 'provider.model'], provides: ['request.anthropicMessages'], consumes: [] },
    response: { needs: ['response.anthropicMessages'], provides: ['response.anthropicMessages'], consumes: [] },
  },
  return: { provides: ['response.http', 'response.anthropicMessages'] },
  async execute(facts, scope) {
    const body = facts['request.anthropicMessages'];
    const selection = selectAnthropicModel(facts['provider.model'], body.speed);
    if (!selection.ok) {
      const { http, outcome } = invalidModel(selection.error, true);
      return { 'response.http': http, 'response.anthropicMessages': outcome };
    }

    const { modelId, speed } = selection.value;
    const { speed: _speed, ...rest } = body;
    const answer = await scope.next({
      ...facts,
      'request.anthropicMessages': { ...(speed === undefined ? body : rest), model: modelId, stream: true },
    });
    const outcome = answer['response.anthropicMessages'];
    if (outcome.kind !== 'stream' || speed === undefined) return answer;
    // Kimi accepts fast mode without labelling the returned usage with its speed.
    // https://www.kimi.com/code/docs/en/kimi-code/models.html
    // https://platform.claude.com/docs/en/build-with-claude/fast-mode
    const stream = scope.wrapStream(outcome.stream, async function* (source, producer) {
      for await (const item of producer.read(source)) {
        if (item.ok && item.value.type === 'message_start') {
          const event = item.value;
          yield { ok: true, value: { ...event, message: { ...event.message, usage: { ...event.message.usage, speed } } } };
        } else {
          yield item;
        }
      }
    });
    return { ...answer, 'response.anthropicMessages': { kind: 'stream', stream } };
  },
});
