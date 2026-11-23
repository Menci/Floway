import type { CandidateRequest } from '../../../pipeline/failover.ts';
import { foldsExclusiveCacheTokens } from '../../../shared/telemetry/usage.ts';
import { defineStage } from '@floway-dev/pipeline';
import { eventFrame } from '@floway-dev/protocols/common';
import type { OpenAIResponsesResultEx } from '@floway-dev/protocols/openai-responses';
import type { ProviderResponsesOutput } from '@floway-dev/provider';

type Usage = OpenAIResponsesResultEx['usage'];

const normalizeUsage = (usage: Usage, exclusive: boolean, identity: string): Usage => {
  if (!usage) return usage;
  const { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: totalTokens } = usage;
  if (typeof inputTokens !== 'number' || typeof outputTokens !== 'number') return usage;
  const cacheRead = usage.input_tokens_details?.cached_tokens ?? 0;
  const cacheWrite = usage.input_tokens_details?.cache_write_tokens ?? 0;
  if (cacheRead === 0 && cacheWrite === 0) return usage;
  if (!foldsExclusiveCacheTokens(exclusive, { inputTokens, outputTokens, totalTokens, cacheRead, cacheWrite }, identity)) return usage;
  return { ...usage, input_tokens: inputTokens + cacheRead + cacheWrite };
};

export const normalizeExclusiveCachedTokens = defineStage<CandidateRequest, CandidateRequest, ProviderResponsesOutput, ProviderResponsesOutput>({
  name: 'normalizeExclusiveCachedTokens',
  through: {
    request: { needs: ['route.candidate'], consumes: [], provides: [] },
    response: { needs: ['response.events', 'response.result'], consumes: [], provides: ['response.events', 'response.result'] },
  },
  execute: async (facts, next, env) => {
    const candidate = facts['route.candidate'];
    const exclusive = candidate.providerModel.enabledFlags.includes('usage-exclusive-cached-tokens');
    const identity = `${candidate.upstreamId}/${candidate.modelId}`;
    const response = await next(facts);
    const { 'response.events': stream, 'response.result': result } = response;
    const mapUsage = <T extends { usage?: Usage }>(resource: T): T => {
      const usage = normalizeUsage(resource.usage, exclusive, identity);
      return usage === resource.usage ? resource : { ...resource, usage };
    };
    const events = stream === undefined ? undefined : env.wrapStream(stream, {
      label: 'normalized OpenAI Responses usage',
      async *transform(source) {
        for await (const frame of source) {
          if (frame.type === 'event' && 'response' in frame.event) {
            const resource = mapUsage(frame.event.response);
            yield resource === frame.event.response ? frame : eventFrame({ ...frame.event, response: resource });
          } else {
            yield frame;
          }
        }
      },
    });
    return { ...response, 'response.events': events, 'response.result': result === undefined ? undefined : mapUsage(result) };
  },
});
