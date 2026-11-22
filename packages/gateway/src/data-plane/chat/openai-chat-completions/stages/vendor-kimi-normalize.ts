// Kimi (Moonshot) accepts the canonical outbound OpenAI Chat Completions shape.
// Its response usage reports cached prefix tokens as a flat `cached_tokens`
// field, which we remap into OpenAI's `prompt_tokens_details.cached_tokens`.
// https://platform.kimi.com/docs/api/chat
import { asJsonObject, readJsonNumber } from '../../../../shared/json-helpers.ts';
import type { ChatAttemptOutcome, ChatPipelineServices, OpenAIChatCompletionsAttemptInput } from '../../pipeline/index.ts';
import { billableUsageFromOpenAIChatCompletionsEvent } from '../usage.ts';
import { defineStage } from '@floway-dev/pipeline';
import { eventFrame } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import { hasEnabledFlag, type ChatTargetApi } from '@floway-dev/provider';

interface Facts extends OpenAIChatCompletionsAttemptInput {
  readonly 'route.targetApi': ChatTargetApi;
}

const rewriteInboundUsage = (chunk: OpenAIChatCompletionsStreamEvent): OpenAIChatCompletionsStreamEvent => {
  const usage = asJsonObject(chunk.usage);
  if (usage === null) return chunk;
  const cached = readJsonNumber(usage.cached_tokens);
  if (cached === null) return chunk;
  const { cached_tokens: _stripped, ...rest } = usage;
  return {
    ...chunk,
    usage: {
      ...rest,
      prompt_tokens_details: {
        ...(asJsonObject(usage.prompt_tokens_details) ?? {}),
        cached_tokens: cached,
      },
    } as unknown as OpenAIChatCompletionsStreamEvent['usage'],
  };
};

// The stage is always attached and flag-gated; it reads the upstream dialect
// before generic usage normalization.
export const vendorKimiNormalize = defineStage<
  Facts,
  Record<never, never>,
  ChatAttemptOutcome<OpenAIChatCompletionsStreamEvent>,
  ChatAttemptOutcome<OpenAIChatCompletionsStreamEvent>,
  never,
  ChatPipelineServices
>({
  name: 'vendorKimiNormalize',
  execute: async (facts, next, env) => {
    const outcome = await next();
    if (outcome.type !== 'events' || !hasEnabledFlag(facts['route.candidate'].providerModel, 'vendor-kimi')) {
      return outcome;
    }
    return {
      ...outcome,
      events: env.wrapStream(outcome.events, {
        label: 'openai-chat-completions.vendor-kimi',
        async *transform(source) {
          for await (const frame of source) {
            if (frame.type !== 'event') {
              yield frame;
              continue;
            }
            const event = rewriteInboundUsage(frame.event);
            if (event === frame.event) {
              yield frame;
              continue;
            }
            if (outcome.usageId !== undefined) {
              const usage = billableUsageFromOpenAIChatCompletionsEvent(event);
              if (usage !== null) env.usageLedger.updateBillableUsage(outcome.usageId, usage);
            }
            yield eventFrame(event);
          }
        },
      }),
    };
  },
});
