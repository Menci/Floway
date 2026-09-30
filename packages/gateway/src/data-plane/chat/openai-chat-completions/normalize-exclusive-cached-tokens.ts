import { asJsonObject } from '../../../shared/json-helpers.ts';
import type { AttemptSelector } from '../../pipeline/facts.ts';
import type { Chat } from '../facts.ts';
import { attemptIdentity } from '../shared/attempt-identity.ts';
import { withCacheBucketsFolded, type CacheBucketNames } from '../shared/cache-buckets.ts';
import { answerWithFrames, rewritingEvents } from '../shared/frames.ts';
import { defineStage, transform, move } from '@floway-dev/pipeline';
import type { OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';

/**
 * Restores OpenAI's inclusive input-token contract on an upstream that reports the cache
 * buckets alongside `prompt_tokens` instead of inside it. The fold, the evidence for the two
 * conventions and the contradictions it raises are at `withCacheBucketsFolded`.
 *
 * Unconditional on this wire rather than flag-gated: `foldsExclusiveCacheTokens` reads
 * `total_tokens` as the witness, and the `usage-exclusive-cached-tokens` flag is a declaration
 * input for the responses whose totals witness nothing.
 *
 * Everything it says is about one upstream's OpenAI Chat Completions wire — the flag it reads
 * describes how that upstream writes its usage there, and the remedy its errors name is a
 * setting for that upstream. That is why it belongs to the wire: on any other wire these
 * events are a projection of some other protocol, where the flag answers a question about
 * counts it does not describe and telling an operator to set it would be advice that cannot
 * help. Nothing is lost by standing down there — a translator emits the canonical form, which
 * is the one case the fold has nothing to do with.
 *
 * It runs below the vendor normalizers, so on the way back it reads usage whose cache fields
 * already carry OpenAI's names.
 */
export const normalizeExclusiveCachedTokensForOpenAIChatCompletions = defineStage<
  Chat<'route.attempt'>,
  Chat<'route.attempt'>,
  Chat<'response.chat.openaiChatCompletions'>,
  Chat<'response.chat.openaiChatCompletions'>
>({
  name: 'normalizeExclusiveCachedTokens',
  through: {
    request: { needs: ['route.attempt'], consumes: [], provides: [] },
    response: {
      needs: ['response.chat.openaiChatCompletions'],
      consumes: [],
      provides: ['response.chat.openaiChatCompletions'],
    },
  },
  execute: transform<
    Chat<'route.attempt'>,
    Chat<'route.attempt'>,
    Chat<'response.chat.openaiChatCompletions'>,
    Chat<'response.chat.openaiChatCompletions'>
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
        const answer = answerWithFrames<OpenAIChatCompletionsStreamEvent>(
          facts['response.chat.openaiChatCompletions'],
          frames => rewritingEvents(frames, chunk => foldOpenAIChatCompletionsUsage(chunk, declaredExclusive, identity)),
        );
        return answer === null ? facts : { ...facts, 'response.chat.openaiChatCompletions': move(answer) };
      },
    };
  }),
});

/** OpenAI Chat Completions carries usage on the chunk's own root and names the buckets
 *  `prompt_tokens` and `prompt_tokens_details.{cached_tokens, cache_creation_input_tokens}`. */
const OPENAI_CHAT_COMPLETIONS_CACHE_BUCKETS: CacheBucketNames = {
  input: 'prompt_tokens',
  output: 'completion_tokens',
  details: 'prompt_tokens_details',
  cacheWrite: ['cache_creation_input_tokens', 'cache_write_tokens'],
};

const foldOpenAIChatCompletionsUsage = (
  chunk: OpenAIChatCompletionsStreamEvent,
  declaredExclusive: boolean,
  identity: string,
): OpenAIChatCompletionsStreamEvent => {
  const usage = asJsonObject(chunk.usage);
  if (usage === null) return chunk;
  const folded = withCacheBucketsFolded(usage, OPENAI_CHAT_COMPLETIONS_CACHE_BUCKETS, declaredExclusive, identity);
  return folded === usage ? chunk : { ...chunk, usage: folded as unknown as OpenAIChatCompletionsStreamEvent['usage'] };
};
