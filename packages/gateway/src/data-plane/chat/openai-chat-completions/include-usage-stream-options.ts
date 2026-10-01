import type { Chat } from '../facts.ts';
import { defineStage, transform, move } from '@floway-dev/pipeline';

/**
 * Asks the upstream for the usage chunk that billing is read off.
 *
 * OpenAI Chat Completions emits the final usage-only chunk only when `stream_options.include_usage`
 * is on, and the gateway meters every stream from those frames — so what the client asked for
 * and what the upstream is asked for differ here, which is the one thing this rule exists to
 * say. Nothing downstream has to thread the client's original value through, because it is a
 * fact of its own: `ingress.chat.openaiChatCompletions.wantsUsageChunk` describes the request that
 * arrived and survives this rewrite, and the edge reads it to decide who is shown the chunk.
 *
 * It belongs to the wire rather than to the source chain because it names a field of *this*
 * protocol's request. Every source protocol that reaches an upstream over this endpoint runs
 * it — an Anthropic Messages or Gemini generateContent turn served here would otherwise be metered off a stream that was
 * never asked to report anything — and a turn that leaves for another wire gets that wire's
 * own rule for the same thing.
 *
 * Reference: https://platform.openai.com/docs/api-reference/chat/create
 */
export const includeUsageStreamOptionsForOpenAIChatCompletions = defineStage<
  Chat<'request.chat.openaiChatCompletions'>,
  Chat<'request.chat.openaiChatCompletions'>,
  Chat<'response.chat.openaiChatCompletions'>,
  Chat<'response.chat.openaiChatCompletions'>
>({
  name: 'includeUsageStreamOptions',
  through: {
    request: {
      needs: ['request.chat.openaiChatCompletions'],
      consumes: [],
      provides: ['request.chat.openaiChatCompletions'],
    },
    response: { needs: ['response.chat.openaiChatCompletions'], consumes: [], provides: [] },
  },
  execute: transform<
    Chat<'request.chat.openaiChatCompletions'>,
    Chat<'request.chat.openaiChatCompletions'>,
    Chat<'response.chat.openaiChatCompletions'>,
    Chat<'response.chat.openaiChatCompletions'>
  >(() => ({
    request: facts => {
      const payload = facts['request.chat.openaiChatCompletions'];
      if (payload.stream_options?.include_usage === true) return facts;
      // Whatever else the client put on `stream_options` is its own and stays; only the one
      // field the gateway has an interest in is written.
      return {
        ...facts,
        'request.chat.openaiChatCompletions': move({
          ...payload,
          stream_options: { ...payload.stream_options, include_usage: true },
        }),
      };
    },
  })),
});
