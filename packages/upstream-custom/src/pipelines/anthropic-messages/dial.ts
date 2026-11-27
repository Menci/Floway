import { customModelRequest, customStream, defineStage, dialResponseConsumes, dialResponseNeeds } from '../http.ts';
import { decodeAnthropicMessagesStream } from '@floway-dev/protocols/anthropic-messages';

export const anthropicMessagesDial = defineStage({
  name: 'custom.anthropicMessages.dial',
  through: {
    request: { needs: ['http', 'upstream', 'model', 'anthropicMessages'], provides: ['http'], consumes: [] },
    response: { needs: dialResponseNeeds, provides: ['http', 'anthropicMessages'], consumes: dialResponseConsumes },
  },
  async execute(facts, scope) {
    const { http, upstream, model, anthropicMessages } = facts;
    const request = customModelRequest(http, upstream, '/messages', model.upstreamModelId, { ...anthropicMessages, stream: true }, 'x-api-key');
    const answer = await scope.next({ ...facts, http: request });
    const parsed = await customStream(answer, scope, decodeAnthropicMessagesStream, 'x-api-key');
    return { http: parsed.http, anthropicMessages: parsed.outcome };
  },
});
