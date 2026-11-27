import { foldsExclusiveCacheTokens } from '../../../shared/telemetry/usage.ts';
import { defineStage } from '../../pipeline/facts.ts';
import { mapProtocolEvents } from '../../pipeline/stream-transform.ts';
import type { OpenAIChatCompletionsStreamEvent, OpenAIChatCompletionsUsageEx } from '@floway-dev/protocols/openai-chat-completions';

// Restore the inclusive input total the OpenAI schema assigns to prompt_tokens.
// https://github.com/openai/openai-openapi/blob/d4fb706e6e05d4cc9f1b33ca59b6e4f3e8edd439/openapi.yaml#L51043-L51049
const normalizeUsage = (event: OpenAIChatCompletionsStreamEvent, declaredExclusive: boolean, identity: string): OpenAIChatCompletionsStreamEvent => {
  const usage: OpenAIChatCompletionsUsageEx | null | undefined = event.usage;
  if (!usage) return event;
  const { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: totalTokens, prompt_tokens_details: details } = usage;
  const cacheRead = details?.cached_tokens ?? 0;
  const cacheWrite = details?.cache_creation_input_tokens ?? details?.cache_write_tokens ?? 0;
  if (cacheRead === 0 && cacheWrite === 0) return event;

  return foldsExclusiveCacheTokens(declaredExclusive, { inputTokens, outputTokens, totalTokens, cacheRead, cacheWrite }, identity)
    ? { ...event, usage: { ...usage, prompt_tokens: inputTokens + cacheRead + cacheWrite } }
    : event;
};

export const normalizeOpenAIChatCompletionsCachedTokens = defineStage({
  name: 'openaiChatCompletions.normalize-exclusive-cached-tokens',
  through: {
    request: { needs: ['model', 'upstream'], provides: [], consumes: [] },
    response: { needs: ['openaiChatCompletions'], provides: ['openaiChatCompletions'], consumes: [] },
  },
  async execute(facts, scope) {
    const answer = await scope.next(facts);
    const outcome = answer.openaiChatCompletions;
    if (outcome.kind !== 'stream') return answer;
    const declaredExclusive = facts.model.enabledFlags.includes('usage-exclusive-cached-tokens');
    const identity = `${facts.upstream.id}/${facts.model.id}`;
    const stream = scope.wrapStream(outcome.stream, (source, producer) => mapProtocolEvents<OpenAIChatCompletionsStreamEvent, OpenAIChatCompletionsStreamEvent>(source, producer,
      event => normalizeUsage(event, declaredExclusive, identity)));
    return { ...answer, openaiChatCompletions: { kind: 'stream', stream } };
  },
});
