import { readJsonNumber } from '../../../../shared/json-helpers.ts';
import { gatewayFactSpace } from '../../../pipeline/facts.ts';
import { foldsExclusiveCacheTokens } from '../../../shared/telemetry/usage.ts';
import { move, transform } from '@floway-dev/pipeline';
import type { OpenAIResponsesResultEx } from '@floway-dev/protocols/openai-responses';

const { defineStage } = gatewayFactSpace<{}>();

const normalize = <Response extends { readonly usage?: OpenAIResponsesResultEx['usage'] }>(
  response: Response,
  declaredExclusive: boolean,
  identity: string,
): Response => {
  const { usage } = response;
  if (usage == null) return response;
  const inputTokens = readJsonNumber(usage.input_tokens);
  const outputTokens = readJsonNumber(usage.output_tokens);
  if (inputTokens == null || outputTokens == null) return response;

  const cacheRead = readJsonNumber(usage.input_tokens_details?.cached_tokens) ?? 0;
  const cacheWrite = readJsonNumber(usage.input_tokens_details?.cache_write_tokens) ?? 0;
  if (cacheRead === 0 && cacheWrite === 0) return response;
  if (!foldsExclusiveCacheTokens(declaredExclusive, {
    inputTokens,
    outputTokens,
    totalTokens: readJsonNumber(usage.total_tokens) ?? undefined,
    cacheRead,
    cacheWrite,
  }, identity)) return response;

  return { ...response, usage: { ...usage, input_tokens: inputTokens + cacheRead + cacheWrite } };
};

// Each lifecycle event repeats a resource. Normalize all its copies before
// measuring usage so scalar and streamed Responses share inclusive totals.
export const normalizeOpenAIResponsesExclusiveCachedTokens = defineStage({
  name: 'openaiResponses.normalize-exclusive-cached-tokens',
  through: {
    request: { needs: ['serve.candidate'], provides: [], consumes: [] },
    response: { needs: ['response.openaiResponses'], provides: ['response.openaiResponses'], consumes: [] },
  },
  execute: transform(scope => {
    let declaredExclusive: boolean;
    let identity: string;
    return {
      request(facts) {
        const { model, upstream } = facts['serve.candidate'];
        declaredExclusive = model.enabledFlags.includes('usage-exclusive-cached-tokens');
        identity = `${upstream.id}/${model.id}`;
        return facts;
      },
      response(facts) {
        const outcome = facts['response.openaiResponses'];
        switch (outcome.kind) {
        case 'error': return facts;
        case 'result': {
          const result = normalize(outcome.result, declaredExclusive, identity);
          return { ...facts, 'response.openaiResponses': move({ kind: 'result', result } as const) };
        }
        case 'stream': {
          const stream = scope.wrapStream(outcome.stream, async function* (items) {
            for await (const item of items) {
              if (!item.ok || !('response' in item.value)) {
                yield item;
                continue;
              }
              const { value } = item;
              const response = normalize(value.response, declaredExclusive, identity);
              yield response === value.response ? item : { ok: true, value: { ...value, response } };
            }
          });
          return { ...facts, 'response.openaiResponses': move({ kind: 'stream', stream } as const) };
        }
        }
      },
    };
  }),
});
