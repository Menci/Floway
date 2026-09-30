import { asJsonObject, type JsonObject } from '../../../shared/json-helpers.ts';
import type { AttemptSelector } from '../../pipeline/facts.ts';
import type { Chat } from '../facts.ts';
import { attemptIdentity } from '../shared/attempt-identity.ts';
import { withCacheBucketsFolded, type CacheBucketNames } from '../shared/cache-buckets.ts';
import { answerWithFrames, rewritingEvents } from '../shared/frames.ts';
import { defineStage, transform, move } from '@floway-dev/pipeline';
import type { OpenAIResponsesStreamEvent } from '@floway-dev/protocols/openai-responses';

/**
 * Restores OpenAI's inclusive input-token contract on an upstream that reports the cache
 * buckets alongside `input_tokens` instead of inside it.
 *
 * Unconditional on this chain rather than flag-gated: `foldsExclusiveCacheTokens` owns the
 * decision and reads `total_tokens` as the witness, and the `usage-exclusive-cached-tokens`
 * flag is a declaration input for the responses whose totals witness nothing. Every event
 * that carries a response resource repeats the whole resource, so the rewrite applies to each
 * of them rather than to a single terminal frame. The evidence for the two conventions and
 * the contradictions that raise are documented at `foldsExclusiveCacheTokens` and at
 * `withCacheBucketsFolded`, which is the fold itself.
 */
export const normalizeExclusiveCachedTokensForOpenAIResponses = defineStage<
  Chat<'route.attempt'>,
  Chat<'route.attempt'>,
  Chat<'response.chat.openaiResponses'>,
  Chat<'response.chat.openaiResponses'>
>({
  name: 'normalizeExclusiveCachedTokens',
  through: {
    request: { needs: ['route.attempt'], consumes: [], provides: [] },
    response: { needs: ['response.chat.openaiResponses'], consumes: [], provides: ['response.chat.openaiResponses'] },
  },
  execute: transform<
    Chat<'route.attempt'>,
    Chat<'route.attempt'>,
    Chat<'response.chat.openaiResponses'>,
    Chat<'response.chat.openaiResponses'>
  >(() => {
    // Which attempt this is gets read on the way down and spoken about on the way back, which
    // is the order `transform` runs the two halves in.
    let attempt!: AttemptSelector;
    return {
      request: facts => {
        attempt = facts['route.attempt'];
        return facts;
      },
      response: facts => {
        const declaredExclusive = attempt.flags.includes('usage-exclusive-cached-tokens');
        const identity = attemptIdentity(attempt);
        const answer = answerWithFrames<OpenAIResponsesStreamEvent>(
          facts['response.chat.openaiResponses'],
          frames => rewritingEvents(frames, event => foldOpenAIResponsesUsage(event, declaredExclusive, identity)),
        );
        return answer === null ? facts : { ...facts, 'response.chat.openaiResponses': move(answer) };
      },
    };
  }),
});

/** OpenAI Responses carries usage on `event.response.usage` and names the buckets `input_tokens` and
 *  `input_tokens_details.{cached_tokens, cache_write_tokens}`. */
const OPENAI_RESPONSES_CACHE_BUCKETS: CacheBucketNames = {
  input: 'input_tokens',
  output: 'output_tokens',
  details: 'input_tokens_details',
  cacheWrite: ['cache_write_tokens'],
};

const foldOpenAIResponsesUsage = (
  event: OpenAIResponsesStreamEvent,
  declaredExclusive: boolean,
  identity: string,
): OpenAIResponsesStreamEvent => {
  if (!('response' in event)) return event;
  const response = asJsonObject(event.response);
  const usage = asJsonObject(response?.usage);
  if (response === null || usage === null) return event;
  const folded = withCacheBucketsFolded(usage, OPENAI_RESPONSES_CACHE_BUCKETS, declaredExclusive, identity);
  if (folded === usage) return event;
  return { ...event, response: { ...response, usage: folded } as JsonObject } as unknown as OpenAIResponsesStreamEvent;
};
