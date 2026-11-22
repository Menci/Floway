import type { OpenAIResponsesStageFacts, OpenAIResponsesStageOutcome } from './facts.ts';
import { asJsonObject, type JsonObject, readJsonNumber } from '../../../../shared/json-helpers.ts';
import { foldsExclusiveCacheTokens } from '../../../shared/telemetry/usage.ts';
import type { ChatPipelineServices } from '../../pipeline/index.ts';
import { billableUsageFromOpenAIResponsesEvent } from '../usage.ts';
import { defineStage } from '@floway-dev/pipeline';
import { eventFrame } from '@floway-dev/protocols/common';
import type { OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import { hasEnabledFlag } from '@floway-dev/provider';

const rewriteInboundUsage = (
  event: OpenAIResponsesStreamEventEx,
  declaredExclusive: boolean,
  identity: string,
): OpenAIResponsesStreamEventEx => {
  if (!('response' in event)) return event;
  const response = asJsonObject(event.response);
  const usage = asJsonObject(response?.usage);
  if (response === null || usage === null) return event;
  const inputTokens = readJsonNumber(usage.input_tokens);
  const outputTokens = readJsonNumber(usage.output_tokens);
  if (inputTokens === null || outputTokens === null) return event;

  const details = asJsonObject(usage.input_tokens_details);
  const cacheRead = readJsonNumber(details?.cached_tokens) ?? 0;
  const cacheWrite = readJsonNumber(details?.cache_write_tokens) ?? 0;
  if (cacheRead === 0 && cacheWrite === 0) return event;

  const fold = foldsExclusiveCacheTokens(declaredExclusive, {
    inputTokens,
    outputTokens,
    totalTokens: readJsonNumber(usage.total_tokens) ?? undefined,
    cacheRead,
    cacheWrite,
  }, identity);
  if (!fold) return event;

  const nextUsage: JsonObject = { ...usage, input_tokens: inputTokens + cacheRead + cacheWrite };
  const nextResponse: JsonObject = { ...response, usage: nextUsage };
  return { ...event, response: nextResponse } as unknown as OpenAIResponsesStreamEventEx;
};

// Restore OpenAI's inclusive input-token contract when an upstream reports
// cache buckets alongside `input_tokens`. Downstream pricing subtracts cache
// reads and writes on the inclusive convention.
export const normalizeExclusiveCachedTokens = defineStage<
  OpenAIResponsesStageFacts,
  Record<never, never>,
  OpenAIResponsesStageOutcome,
  OpenAIResponsesStageOutcome,
  never,
  ChatPipelineServices
>({
  name: 'normalizeExclusiveCachedTokens',
  execute: async (facts, next, env) => {
    const outcome = await next();
    if (outcome.type !== 'events' || facts['route.targetApi'] !== 'openaiResponses') return outcome;

    const candidate = facts['route.candidate'];
    const declaredExclusive = hasEnabledFlag(candidate.providerModel, 'usage-exclusive-cached-tokens');
    const identity = `${candidate.upstreamId}/${candidate.modelId}`;
    return {
      ...outcome,
      events: env.wrapStream(outcome.events, {
        label: 'openai-responses.normalize-exclusive-cached-tokens',
        async *transform(source) {
          for await (const frame of source) {
            if (frame.type !== 'event') {
              yield frame;
              continue;
            }
            const event = rewriteInboundUsage(frame.event, declaredExclusive, identity);
            if (outcome.usageId !== undefined) {
              const usage = billableUsageFromOpenAIResponsesEvent(event);
              if (usage !== null) env.usageLedger.updateBillableUsage(outcome.usageId, usage);
            }
            yield event === frame.event ? frame : eventFrame(event);
          }
        },
      }),
    };
  },
});
