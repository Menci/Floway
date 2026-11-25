import { asJsonObject, readJsonNumber } from '../../../../shared/json-helpers.ts';
import { gatewayFactSpace } from '../../../pipeline/facts.ts';
import { foldsExclusiveCacheTokens } from '../../../shared/telemetry/usage.ts';
import { move, transform } from '@floway-dev/pipeline';
import type { OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';

const { defineStage } = gatewayFactSpace<{}>();
const key = 'response.openaiChatCompletions';

// OpenAI includes cache counts in prompt_tokens. Some Anthropic-to-OpenAI
// gateways carry exclusive input counts across while preserving the original total.
// https://github.com/openai/openai-openapi/blob/d4fb706e6e05d4cc9f1b33ca59b6e4f3e8edd439/openapi.yaml#L51043-L51049
// https://github.com/Portkey-AI/gateway/blob/669825cbe89ee51569918b8f78a9db486fd69dd4/src/providers/anthropic/chatComplete.ts#L612-L627
export const normalizeExclusiveCachedTokens = defineStage({
  name: 'openaiChatCompletions.normalize-exclusive-cached-tokens',
  through: {
    request: { needs: ['serve.candidate'], provides: [], consumes: [] },
    response: { needs: [key], provides: [key], consumes: [] },
  },
  execute: transform(scope => {
    let declaredExclusive: boolean;
    let identity: string;
    return {
      request: facts => {
        const { model, upstream } = facts['serve.candidate'];
        declaredExclusive = model.enabledFlags.includes('usage-exclusive-cached-tokens');
        identity = `${upstream.id}/${model.id}`;
        return facts;
      },
      response: facts => {
        const outcome = facts[key];
        if (outcome.kind !== 'stream') return facts;
        const stream = scope.wrapStream(outcome.stream, async function* (items) {
          for await (const item of items) {
            yield item.ok ? { ok: true, value: rewriteUsage(item.value, declaredExclusive, identity) } : item;
          }
        });
        return { ...facts, [key]: move({ kind: 'stream', stream } as const) };
      },
    };
  }),
});

const rewriteUsage = (chunk: OpenAIChatCompletionsStreamEvent, declaredExclusive: boolean, identity: string): OpenAIChatCompletionsStreamEvent => {
  const usage = asJsonObject(chunk.usage);
  if (usage === null) return chunk;
  const inputTokens = readJsonNumber(usage.prompt_tokens);
  const outputTokens = readJsonNumber(usage.completion_tokens);
  if (inputTokens == null || outputTokens == null) return chunk;

  const details = asJsonObject(usage.prompt_tokens_details);
  const cacheRead = readJsonNumber(details?.cached_tokens) ?? 0;
  const cacheWrite = readJsonNumber(details?.cache_creation_input_tokens) ?? readJsonNumber(details?.cache_write_tokens) ?? 0;
  if (cacheRead === 0 && cacheWrite === 0) return chunk;
  if (!foldsExclusiveCacheTokens(declaredExclusive, {
    inputTokens,
    outputTokens,
    totalTokens: readJsonNumber(usage.total_tokens) ?? undefined,
    cacheRead,
    cacheWrite,
  }, identity)) return chunk;

  return { ...chunk, usage: { ...chunk.usage!, prompt_tokens: inputTokens + cacheRead + cacheWrite } };
};
