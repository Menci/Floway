// The three interceptors three chat protocols share, migrated. Two properties matter and
// neither is about the rewrites themselves — those are transcribed from code that already
// worked. What is new is that a stage returns a record instead of assigning to a context,
// and that a rewrite which changes nothing changes nothing by identity.

import { describe, expect, it } from 'vitest';

import type { Chat } from '../../src/data-plane/chat/facts.ts';
import {
  applyRoleCompatibilityToChatCompletions,
  disableReasoningOnForcedToolChoiceForChatCompletions,
  stripPromptCacheKeyForChatCompletions,
} from '../../src/data-plane/chat/interceptors.ts';
import type { AttemptSelector } from '../../src/data-plane/pipeline/facts.ts';
import { move, run, compose, defineStage } from '@floway-dev/pipeline';
import type { ChatCompletionsPayload } from '@floway-dev/protocols/chat-completions';

/** What an attempt is, to a stage that only reads flags. The selector carries them as data,
 *  so nothing here needs the live candidate the resolver kept. */
const attemptWith = (...flags: string[]): AttemptSelector => ({ upstreamId: 'u', modelId: 'm', flags });

const payload = (messages: ChatCompletionsPayload['messages'], rest: Partial<ChatCompletionsPayload> = {}): ChatCompletionsPayload =>
  ({ model: 'm', messages, ...rest }) as ChatCompletionsPayload;

/** Runs one stage and hands back what it passed down, which is the only thing these
 *  stages do — none of them touches the response direction. The sink has to provide the
 *  answer the stage above declared it needs, or `compose` refuses the array; that refusal
 *  is the assembly check doing its job and is why the harness looks like this. */
const handedDown = async (stage: unknown, facts: object): Promise<Record<string, unknown>> => {
  let seen: Record<string, unknown> = {};
  const sink = defineStage<object, Chat<'response.chat.chatCompletions'>>({
    name: 'sink',
    return: { provides: ['response.chat.chatCompletions'] },
    execute: async received => {
      seen = received as Record<string, unknown>;
      return move({ ...received, 'response.chat.chatCompletions': { kind: 'value' as const, body: null } });
    },
  });
  await run(compose('one', [stage as never, sink]), move(facts) as never, {});
  return seen;
};

describe('the shared chat interceptors, as stages', () => {
  it('rewrites the roles its flags name, in the settled order', async () => {
    const down = await handedDown(applyRoleCompatibilityToChatCompletions, {
      'request.chat.chatCompletions': payload([
        { role: 'system', content: 'lead' },
        { role: 'user', content: 'hi' },
        { role: 'system', content: 'mid' },
      ]),
      'route.attempt': attemptWith('rewrite-system-to-developer'),
    });
    const after = down['request.chat.chatCompletions'] as ChatCompletionsPayload;
    expect(after.messages.map(m => m.role)).toEqual(['developer', 'user', 'developer']);
  });

  it('turns only a mid-conversation system message into a user one', async () => {
    const down = await handedDown(applyRoleCompatibilityToChatCompletions, {
      'request.chat.chatCompletions': payload([
        { role: 'system', content: 'lead' },
        { role: 'system', content: 'still lead' },
        { role: 'user', content: 'hi' },
        { role: 'system', content: 'mid' },
      ]),
      'route.attempt': attemptWith('rewrite-mid-conv-system-to-user'),
    });
    const after = down['request.chat.chatCompletions'] as ChatCompletionsPayload;
    expect(after.messages.map(m => m.role)).toEqual(['system', 'system', 'user', 'user']);
  });

  // The convention the whole exact-recording story rests on. A stage whose flags do not
  // fire must hand the payload back as the *same object*, or every layer costs a copy of
  // the conversation and the dump stops being affordable.
  it('hands the same payload back by identity when no flag fires', async () => {
    const original = payload([{ role: 'system', content: 'lead' }]);
    const down = await handedDown(applyRoleCompatibilityToChatCompletions, {
      'request.chat.chatCompletions': original,
      'route.attempt': attemptWith(),
    });
    expect(down['request.chat.chatCompletions']).toBe(original);
  });

  it('hands the same payload back when a flag fires but changes nothing', async () => {
    const original = payload([{ role: 'user', content: 'hi' }]);
    const down = await handedDown(applyRoleCompatibilityToChatCompletions, {
      'request.chat.chatCompletions': original,
      'route.attempt': attemptWith('rewrite-system-to-developer'),
    });
    expect(down['request.chat.chatCompletions']).toBe(original);
  });

  it('shares every message it did not rewrite', async () => {
    const messages = Array.from({ length: 49 }, (_, i) => (
      i === 0 ? { role: 'system' as const, content: 'lead' } : { role: 'user' as const, content: `turn ${i}` }
    ));
    const original = payload(messages);
    const down = await handedDown(applyRoleCompatibilityToChatCompletions, {
      'request.chat.chatCompletions': original,
      'route.attempt': attemptWith('rewrite-system-to-developer'),
    });
    const after = down['request.chat.chatCompletions'] as ChatCompletionsPayload;
    const shared = after.messages.filter((message, index) => message === messages[index]).length;
    expect(shared).toBe(48);   // every message but the one that changed
  });

  it('disables reasoning only when a tool choice is forced', async () => {
    const forced = await handedDown(disableReasoningOnForcedToolChoiceForChatCompletions, {
      'request.chat.chatCompletions': payload([], { tool_choice: 'required' }),
      'route.attempt': attemptWith('disable-reasoning-on-forced-tool-choice'),
    });
    expect((forced['request.chat.chatCompletions'] as ChatCompletionsPayload).reasoning_effort).toBe('none');

    const free = payload([], { tool_choice: 'auto' });
    const untouched = await handedDown(disableReasoningOnForcedToolChoiceForChatCompletions, {
      'request.chat.chatCompletions': free,
      'route.attempt': attemptWith('disable-reasoning-on-forced-tool-choice'),
    });
    expect(untouched['request.chat.chatCompletions']).toBe(free);
  });

  it('removes the prompt cache key, and the key itself rather than its value', async () => {
    const down = await handedDown(stripPromptCacheKeyForChatCompletions, {
      'request.chat.chatCompletions': payload([], { prompt_cache_key: 'k' } as Partial<ChatCompletionsPayload>),
      'route.attempt': attemptWith('strip-prompt-cache-key'),
    });
    const after = down['request.chat.chatCompletions'] as ChatCompletionsPayload;
    // `undefined` is not a removal: the key has to be gone, not present and empty.
    expect('prompt_cache_key' in after).toBe(false);
  });

  it('leaves a payload that never had the key alone, by identity', async () => {
    const original = payload([]);
    const down = await handedDown(stripPromptCacheKeyForChatCompletions, {
      'request.chat.chatCompletions': original,
      'route.attempt': attemptWith('strip-prompt-cache-key'),
    });
    expect(down['request.chat.chatCompletions']).toBe(original);
  });
});
