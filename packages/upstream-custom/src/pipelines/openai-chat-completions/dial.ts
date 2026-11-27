import { customModelRequest, customStream, defineStage, dialResponseConsumes, dialResponseNeeds } from '../http.ts';
import { normalizeChatEvent, normalizeChatRequest } from '../vendor-chat.ts';
import { mistralChatRequest } from '../vendor-mistral.ts';
import { decodeOpenAIChatCompletionsStream } from '@floway-dev/protocols/openai-chat-completions';

export const openaiChatCompletionsDial = defineStage({
  name: 'custom.openaiChatCompletions.dial',
  through: {
    request: { needs: ['http', 'upstream', 'model', 'openaiChatCompletions'], provides: ['http'], consumes: [] },
    response: { needs: dialResponseNeeds, provides: ['http', 'openaiChatCompletions'], consumes: dialResponseConsumes },
  },
  async execute(facts, scope) {
    const { http, upstream, model, openaiChatCompletions } = facts;
    const flags = model.enabledFlags;
    const payload = normalizeChatRequest(openaiChatCompletions, flags);
    const wire = flags.includes('vendor-mistral') ? mistralChatRequest(payload) : payload;
    const request = customModelRequest(http, upstream, '/chat/completions', model.upstreamModelId, { ...wire, stream: true });
    const answer = await scope.next({ ...facts, http: request });
    const parsed = await customStream(answer, scope, decodeOpenAIChatCompletionsStream);
    const outcome = parsed.outcome;
    const deepSeek = flags.includes('vendor-deepseek');
    const kimi = flags.includes('vendor-kimi');
    if (outcome.kind !== 'stream' || (!deepSeek && !kimi)) return { http: parsed.http, openaiChatCompletions: outcome };
    const stream = scope.wrapStream(outcome.stream, async function* (source, producer) {
      for await (const item of producer.read(source)) {
        if (!item.ok) {
          yield item;
          continue;
        }
        const value = normalizeChatEvent(item.value, deepSeek, kimi);
        yield value === item.value ? item : { ok: true, value };
      }
    });
    return { http: parsed.http, openaiChatCompletions: { ...outcome, stream } };
  },
});
