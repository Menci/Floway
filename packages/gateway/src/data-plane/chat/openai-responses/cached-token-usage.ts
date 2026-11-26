import { mapOpenAIResponsesFailedResource } from './stream-error.ts';
import { asJsonObject, readJsonNumber } from '../../../shared/json-helpers.ts';
import { defineStage } from '../../pipeline/facts.ts';
import { foldsExclusiveCacheTokens } from '../../shared/telemetry/usage.ts';
import type { OpenAIResponsesResultEx, OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

export const normalizeOpenAIResponsesResourceUsage = <Output extends { usage?: OpenAIResponsesResultEx['usage'] }>(
  output: Output,
  declaredExclusive: boolean,
  identity: string,
): Output => {
  const usage = asJsonObject(output.usage);
  if (!usage) return output;
  const inputTokens = readJsonNumber(usage.input_tokens);
  const outputTokens = readJsonNumber(usage.output_tokens);
  if (inputTokens == null || outputTokens == null) return output;

  const details = asJsonObject(usage.input_tokens_details);
  const cacheRead = readJsonNumber(details?.cached_tokens) ?? 0;
  const cacheWrite = readJsonNumber(details?.cache_write_tokens) ?? 0;
  if (cacheRead === 0 && cacheWrite === 0) return output;

  const fold = foldsExclusiveCacheTokens(declaredExclusive, {
    inputTokens,
    outputTokens,
    totalTokens: readJsonNumber(usage.total_tokens) ?? undefined,
    cacheRead,
    cacheWrite,
  }, identity);
  if (!fold) return output;

  return { ...output, usage: { ...usage, input_tokens: inputTokens + cacheRead + cacheWrite } };
};

const normalizeEvent = (
  event: OpenAIResponsesStreamEventEx,
  declaredExclusive: boolean,
  identity: string,
): OpenAIResponsesStreamEventEx => {
  if (!('response' in event)) return event;
  const response = normalizeOpenAIResponsesResourceUsage(event.response, declaredExclusive, identity);
  return response === event.response ? event : { ...event, response };
};

export const normalizeOpenAIResponsesCachedTokens = defineStage({
  name: 'openaiResponses.normalize-exclusive-cached-tokens',
  through: {
    request: { needs: ['provider.model', 'provider.upstream'], provides: [], consumes: [] },
    response: { needs: ['response.openaiResponses'], provides: ['response.openaiResponses'], consumes: [] },
  },
  async execute(facts, scope) {
    const model = facts['provider.model'];
    const declaredExclusive = model.enabledFlags.includes('usage-exclusive-cached-tokens');
    const identity = `${facts['provider.upstream'].id}/${model.id}`;
    const answer = await scope.next(facts);
    const outcome = answer['response.openaiResponses'];
    if (outcome.kind !== 'stream') return answer;

    const stream = scope.wrapStream(outcome.stream, async function* (inner, producer) {
      for await (const item of producer.read(inner)) {
        if (!item.ok) {
          producer.discard(inner);
          yield { ok: false, error: await mapOpenAIResponsesFailedResource(item.error, event => normalizeEvent(event, declaredExclusive, identity)) };
          return;
        }
        const event = normalizeEvent(item.value, declaredExclusive, identity);
        yield event === item.value ? item : { ok: true, value: event };
      }
    });
    return { ...answer, 'response.openaiResponses': { kind: 'stream', stream } };
  },
});
