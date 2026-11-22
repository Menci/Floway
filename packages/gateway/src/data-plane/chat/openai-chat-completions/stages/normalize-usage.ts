import { asJsonObject } from '../../../../shared/json-helpers.ts';
import type { ChatAttemptOutcome, ChatPipelineServices, OpenAIChatCompletionsAttemptInput } from '../../pipeline/index.ts';
import { defineStage } from '@floway-dev/pipeline';
import { eventFrame } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import type { ChatTargetApi } from '@floway-dev/provider';

interface Facts extends OpenAIChatCompletionsAttemptInput {
  readonly 'route.targetApi': ChatTargetApi;
}

// The OpenAI streaming contract places usage on a `choices: []` carrier chunk.
// Some compatible upstreams attach it to their final content chunk instead, so
// move it onto a synthesized carrier before any downstream consumer sees it.
// https://platform.openai.com/docs/api-reference/chat-streaming
// Vendor cache-token normalizers are inner stages and translate their dialect
// fields first, so this stage always sees `prompt_tokens_details.cached_tokens`
// in the canonical OpenAI shape.
export const normalizeUsage = defineStage<
  Facts,
  Record<never, never>,
  ChatAttemptOutcome<OpenAIChatCompletionsStreamEvent>,
  ChatAttemptOutcome<OpenAIChatCompletionsStreamEvent>,
  never,
  ChatPipelineServices
>({
  name: 'normalizeUsage',
  execute: async (facts, next, env) => {
    const outcome = await next();
    if (outcome.type !== 'events') return outcome;
    return {
      ...outcome,
      events: env.wrapStream(outcome.events, {
        label: 'openai-chat-completions.normalize-usage',
        async *transform(source) {
          for await (const frame of source) {
            if (frame.type !== 'event') {
              yield frame;
              continue;
            }
            const usage = asJsonObject(frame.event.usage);
            if (usage === null || frame.event.choices.length === 0) {
              yield frame;
              continue;
            }
            const { usage: chunkUsage, ...withoutUsage } = frame.event;
            yield eventFrame(withoutUsage);
            yield eventFrame({ ...withoutUsage, choices: [], usage: chunkUsage });
          }
        },
      }),
    };
  },
});
