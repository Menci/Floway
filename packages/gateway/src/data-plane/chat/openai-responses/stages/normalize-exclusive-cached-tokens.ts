import { readJsonNumber } from '../../../../shared/json-helpers.ts';
import type { CandidateRequest } from '../../../pipeline/failover.ts';
import { foldsExclusiveCacheTokens } from '../../../shared/telemetry/usage.ts';
import type { ChatOutcomeFacts } from '../../shared/route-body.ts';
import { defineStage } from '@floway-dev/pipeline';
import { eventFrame } from '@floway-dev/protocols/common';
import type { OpenAIResponsesResultEx } from '@floway-dev/protocols/openai-responses';

type Outcome = ChatOutcomeFacts<'openaiResponses'>;
type Usage = OpenAIResponsesResultEx['usage'];

const normalizeUsage = (usage: Usage, exclusive: boolean, identity: string): Usage => {
  if (!usage) return usage;
  const inputTokens = readJsonNumber(usage.input_tokens);
  const outputTokens = readJsonNumber(usage.output_tokens);
  if (inputTokens == null || outputTokens == null) return usage;
  const totalTokens = readJsonNumber(usage.total_tokens) ?? undefined;
  const cacheRead = readJsonNumber(usage.input_tokens_details?.cached_tokens) ?? 0;
  const cacheWrite = readJsonNumber(usage.input_tokens_details?.cache_write_tokens) ?? 0;
  if (cacheRead === 0 && cacheWrite === 0) return usage;
  if (!foldsExclusiveCacheTokens(exclusive, { inputTokens, outputTokens, totalTokens, cacheRead, cacheWrite }, identity)) return usage;
  return { ...usage, input_tokens: inputTokens + cacheRead + cacheWrite };
};

export const normalizeExclusiveCachedTokens = defineStage<CandidateRequest, CandidateRequest, Outcome, Outcome>({
  name: 'normalizeExclusiveCachedTokens',
  through: {
    request: { needs: ['route.candidate'], consumes: [], provides: [] },
    response: { needs: ['response.openaiResponses'], consumes: [], provides: ['response.openaiResponses'] },
  },
  execute: async (facts, scope) => {
    const candidate = facts['route.candidate'];
    const exclusive = candidate.providerModel.enabledFlags.includes('usage-exclusive-cached-tokens');
    const identity = `${candidate.upstreamId}/${candidate.modelId}`;
    const response = await scope.next(facts);
    const outcome = response['response.openaiResponses'];
    if (outcome.kind === 'error') return response;
    const mapUsage = <T extends { usage?: Usage }>(resource: T): T => {
      const usage = normalizeUsage(resource.usage, exclusive, identity);
      return usage === resource.usage ? resource : { ...resource, usage };
    };
    if (outcome.kind === 'result') {
      const result = mapUsage(outcome.result);
      return result === outcome.result ? response : { ...response, 'response.openaiResponses': { kind: 'result', result } };
    }
    const events = scope.wrapStream(outcome.events, {
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
    return { ...response, 'response.openaiResponses': { kind: 'stream', events } };
  },
});
