import { mapOpenAIResponsesFailedResource } from './client-stream-error.ts';
import { foldsExclusiveCacheTokens } from '../../../shared/telemetry/usage.ts';
import { defineStage } from '../../pipeline/facts.ts';
import { mapProtocolEvents } from '../../pipeline/stream-transform.ts';
import type { OpenAIResponsesResultEx, OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

export const normalizeOpenAIResponsesResourceUsage = <Output extends { usage?: OpenAIResponsesResultEx['usage'] }>(
  output: Output,
  declaredExclusive: boolean,
  identity: string,
): Output => {
  const usage = output.usage;
  if (!usage) return output;
  const { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: totalTokens, input_tokens_details: details } = usage;
  const cacheRead = details?.cached_tokens ?? 0;
  const cacheWrite = details?.cache_write_tokens ?? 0;
  if (cacheRead === 0 && cacheWrite === 0) return output;
  return foldsExclusiveCacheTokens(declaredExclusive, { inputTokens, outputTokens, totalTokens, cacheRead, cacheWrite }, identity)
    ? { ...output, usage: { ...usage, input_tokens: inputTokens + cacheRead + cacheWrite } }
    : output;
};

export const normalizeOpenAIResponsesCachedTokens = defineStage({
  name: 'openaiResponses.normalize-exclusive-cached-tokens',
  through: {
    request: { needs: ['model', 'upstream'], provides: [], consumes: [] },
    response: { needs: ['openaiResponses'], provides: ['openaiResponses'], consumes: [] },
  },
  async execute(facts, scope) {
    const answer = await scope.next(facts);
    const outcome = answer.openaiResponses;
    if (outcome.kind !== 'stream') return answer;
    const declaredExclusive = facts.model.enabledFlags.includes('usage-exclusive-cached-tokens');
    const identity = `${facts.upstream.id}/${facts.model.id}`;
    const normalizeEvent = (event: OpenAIResponsesStreamEventEx): OpenAIResponsesStreamEventEx => {
      if (!('response' in event)) return event;
      const response = normalizeOpenAIResponsesResourceUsage(event.response, declaredExclusive, identity);
      return response === event.response ? event : { ...event, response };
    };
    const stream = scope.wrapStream(outcome.stream, (source, producer) => mapProtocolEvents(source, producer,
      normalizeEvent, error => mapOpenAIResponsesFailedResource(error, normalizeEvent)));
    return { ...answer, openaiResponses: { kind: 'stream', stream } };
  },
});
