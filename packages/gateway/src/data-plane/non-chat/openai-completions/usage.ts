import { observeUsage } from '../../pipeline/compute-usage.ts';
import { defineStage } from '../../pipeline/facts.ts';
import { foldsExclusiveCacheTokens, openAICacheTokensFromUsage, requestOnlyUsageMeasurement, tokenUsage, tokenUsageMeasurement } from '../../shared/telemetry/usage.ts';
import { billableServiceTier, isJsonObject, isOpenAIUsageOnlyEventShape, splitInclusiveInputTokens } from '@floway-dev/protocols/common';
import type { OpenAICompletionsResult, OpenAICompletionsStreamEvent } from '@floway-dev/protocols/openai-completions';

export const computeOpenAICompletionsUsage = defineStage({
  name: 'openaiCompletions.usage',
  through: {
    request: { needs: ['model', 'upstream'], provides: [], consumes: [] },
    response: { needs: ['openaiCompletions', 'usageModelKey?'], provides: ['openaiCompletions', 'usage'], consumes: ['usageModelKey'] },
  },
  async execute(facts, scope) {
    const { model } = facts;
    const { usageModelKey, ...answer } = await scope.next(facts);
    const observed = observeUsage(scope, answer.openaiCompletions, usageModelKey ?? model.upstreamModelId, completionUsageReaders(model.enabledFlags.includes('usage-exclusive-cached-tokens'), `${facts.upstream.id}/${model.id}`));
    return { ...answer, openaiCompletions: observed.outcome, usage: observed.usage };
  },
});

const completionUsageReaders = (exclusive: boolean, identity: string) => {
  const measure = (usage: unknown, tier: string | null | undefined) => {
    if (!isJsonObject(usage)) return undefined;
    const { prompt_tokens: input, completion_tokens: output, total_tokens: total } = usage;
    if (typeof input !== 'number' || typeof output !== 'number') return undefined;
    const { cacheRead, cacheWrite } = openAICacheTokensFromUsage(usage);
    const fold = foldsExclusiveCacheTokens(exclusive, {
      inputTokens: input,
      outputTokens: output,
      totalTokens: typeof total === 'number' ? total : undefined,
      cacheRead,
      cacheWrite,
    }, identity);
    const split = splitInclusiveInputTokens(fold ? input + cacheRead + cacheWrite : input, cacheRead, cacheWrite);
    return [tokenUsageMeasurement(tokenUsage({
      input: split.input,
      input_cache_read: split.cacheRead,
      input_cache_write: split.cacheWrite,
      output,
      tier: billableServiceTier(tier),
    }))];
  };

  const serviceTier = (value: { service_tier?: unknown }): string | null | undefined => {
    const tier = value.service_tier;
    return tier === null || typeof tier === 'string' ? tier : undefined;
  };

  type CompletionWithTier<Completion> = Completion & { service_tier?: unknown };
  return {
    result(value: CompletionWithTier<OpenAICompletionsResult>) {
      return measure(value.usage, serviceTier(value)) ?? [requestOnlyUsageMeasurement()];
    },
    stream() {
      let usage: unknown;
      let tier: string | null | undefined;
      return {
        frame(event: CompletionWithTier<OpenAICompletionsStreamEvent>) {
          const eventTier = serviceTier(event);
          if (eventTier !== undefined) tier = eventTier;
          if (isOpenAIUsageOnlyEventShape(event)) usage = event.usage;
          return tier === undefined ? undefined : measure(usage, tier);
        },
        done: () => measure(usage, tier) ?? [requestOnlyUsageMeasurement()],
        error: () => measure(usage, tier),
      };
    },
  };
};
