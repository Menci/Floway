import { asJsonObject, readJsonNumber, type JsonObject } from '../../../shared/json-helpers.ts';
import type { Chat } from '../facts.ts';
import { answerWithFrames, rewritingEvents } from '../shared/frames.ts';
import { withoutKeys } from '../shared/structural.ts';
import { defineStage, transform, move } from '@floway-dev/pipeline';
import type { OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';

/** Kimi (Moonshot) reports the cached prefix on a flat `cached_tokens` beside the totals; the
 *  rules above this one read OpenAI's `prompt_tokens_details.cached_tokens`, so it is put
 *  there. Kimi accepts the canonical request shape, so there is nothing to do on the way out.
 *  https://platform.kimi.com/docs/api/chat */
export const vendorKimiNormalizeForOpenAIChatCompletions = defineStage<
  Chat<'route.attempt'>,
  Chat<'route.attempt'>,
  Chat<'response.chat.openaiChatCompletions'>,
  Chat<'response.chat.openaiChatCompletions'>
>({
  name: 'vendorKimiNormalize',
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
    let enabled = false;
    return {
      request: facts => {
        enabled = facts['route.attempt'].flags.includes('vendor-kimi');
        return facts;
      },
      response: facts => {
        if (!enabled) return facts;
        const answer = answerWithFrames<OpenAIChatCompletionsStreamEvent>(
          facts['response.chat.openaiChatCompletions'],
          frames => rewritingEvents(frames, kimiInboundUsage),
        );
        return answer === null ? facts : { ...facts, 'response.chat.openaiChatCompletions': move(answer) };
      },
    };
  }),
});

const kimiInboundUsage = (chunk: OpenAIChatCompletionsStreamEvent): OpenAIChatCompletionsStreamEvent => {
  const usage = asJsonObject(chunk.usage);
  if (usage === null) return chunk;
  const cached = readJsonNumber(usage.cached_tokens);
  if (cached == null) return chunk;
  const next: JsonObject = {
    ...withoutKeys(usage, ['cached_tokens']),
    prompt_tokens_details: { ...(asJsonObject(usage.prompt_tokens_details) ?? {}), cached_tokens: cached },
  };
  return { ...chunk, usage: next as unknown as OpenAIChatCompletionsStreamEvent['usage'] };
};
