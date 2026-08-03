// Responses-shape counterpart of the Chat Completions normalizer of the same
// name. The evidence for the two conventions, the decision rule, and the two
// contradictions that raise are documented once, at
// `../../chat-completions/interceptors/normalize-exclusive-cached-tokens.ts`
// and at `foldsExclusiveCacheTokens`.
//
// Responses carries usage on `event.response.usage` and names the buckets
// `input_tokens` / `input_tokens_details.{cached_tokens, cache_write_tokens}`.
// Every event that carries a response resource repeats the whole resource, so
// the rewrite applies to each of them rather than to a single terminal frame.

import type { ResponsesInterceptor } from './types.ts';
import { asJsonObject, type JsonObject, readJsonNumber } from '../../../../shared/json-helpers.ts';
import { foldsExclusiveCacheTokens } from '../../../shared/telemetry/usage.ts';
import { eventFrame } from '@floway-dev/protocols/common';
import type { ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import { providerModelOf } from '@floway-dev/provider';

const rewriteInboundUsage = (
  event: ResponsesStreamEvent,
  declaredExclusive: boolean,
  identity: string,
): ResponsesStreamEvent => {
  if (!('response' in event)) return event;
  const response = asJsonObject(event.response);
  const usage = asJsonObject(response?.usage);
  if (!response || !usage) return event;
  const inputTokens = readJsonNumber(usage.input_tokens);
  const outputTokens = readJsonNumber(usage.output_tokens);
  if (inputTokens == null || outputTokens == null) return event;

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
  return { ...event, response: nextResponse } as unknown as ResponsesStreamEvent;
};

export const withExclusiveCachedTokensNormalized: ResponsesInterceptor = async (ctx, _gatewayCtx, run) => {
  // Runs only where the wire it speaks about is; see the Chat Completions
  // counterpart.
  if (ctx.targetApi !== 'responses') return await run();

  const model = providerModelOf(ctx.candidate);
  const declaredExclusive = model.enabledFlags.has('usage-exclusive-cached-tokens');
  const identity = `${ctx.candidate.provider.upstreamId}/${model.id}`;

  const result = await run();
  if (result.type !== 'events') return result;

  return {
    ...result,
    events: (async function* () {
      for await (const frame of result.events) {
        if (frame.type !== 'event') {
          yield frame;
          continue;
        }
        const event = rewriteInboundUsage(frame.event, declaredExclusive, identity);
        yield event === frame.event ? frame : eventFrame(event);
      }
    })(),
  };
};
