// The chat interceptors, migrated. Two properties matter and neither is about the rewrites
// themselves — those are transcribed from code that already worked. What is new is that a
// stage returns a record instead of assigning to a context, and that a rewrite which changes
// nothing changes nothing by identity. A rule that speaks about the response direction has a
// third: what it read on the way down has to reach the way back, which is the only thing its
// closure is for.

import { describe, expect, it } from 'vitest';

import {
  applyRoleCompatibilityToChatCompletions,
  applyRoleCompatibilityToMessages,
  applyRoleCompatibilityToResponses,
  disableReasoningOnForcedToolChoiceForChatCompletions,
  disableReasoningOnForcedToolChoiceForMessages,
  disableReasoningOnForcedToolChoiceForResponses,
  includeUsageStreamOptionsForChatCompletions,
  normalizeExclusiveCachedTokensForChatCompletions,
  normalizeExclusiveCachedTokensForResponses,
  normalizeUsageForChatCompletions,
  stripBillingAttributionFromMessages,
  stripPromptCacheKeyForChatCompletions,
  stripPromptCacheKeyForResponses,
  stripSafetySettingsFromGemini,
  stripUnsupportedPartFieldsFromGemini,
  stripUnsupportedToolsFromGemini,
  suppressThoughtPartsFromGemini,
  vendorDeepSeekNormalizeForChatCompletions,
  vendorDeepSeekNormalizeForResponses,
  vendorKimiNormalizeForChatCompletions,
  vendorQwenNormalizeForChatCompletions,
  vendorQwenNormalizeForResponses,
} from '../../src/data-plane/chat/interceptors.ts';
import type { AttemptSelector } from '../../src/data-plane/pipeline/facts.ts';
import { compose, defineStage, move, run } from '@floway-dev/pipeline';
import type { ChatCompletionsPayload, ChatCompletionsStreamEvent } from '@floway-dev/protocols/chat-completions';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiPayload, GeminiStreamEvent } from '@floway-dev/protocols/gemini';
import type { MessagesPayload } from '@floway-dev/protocols/messages';
import type { ResponsesInputItem, ResponsesPayload, ResponsesStreamEvent } from '@floway-dev/protocols/responses';

/** What an attempt is, to a stage that only reads flags. The selector carries them as data,
 *  so nothing here needs the live candidate the resolver kept. */
const attemptWith = (...flags: string[]): AttemptSelector => ({ upstreamId: 'u', modelId: 'm', flags });

/**
 * Runs a family's whole interceptor array, in the order its chain runs it, between stages
 * that declare what its real neighbours declare: an edge that needs the answer, the headers
 * and the billed set on the way up, and an ending that answers with all three.
 *
 * `compose` refuses an array whose declarations do not line up, so an array that runs here is
 * one that family's `pipeline.ts` can hold — which is the whole of what these harnesses check
 * beyond the rewrites themselves.
 */
const runChain = async (
  responseKey: string,
  stages: readonly unknown[],
  facts: Record<string, unknown>,
  answer: unknown = { kind: 'value' as const, body: null },
): Promise<{ readonly down: Record<string, unknown>; readonly up: Record<string, unknown> }> => {
  let down: Record<string, unknown> = {};
  const edge = defineStage<
    Record<string, unknown>,
    Record<string, unknown>,
    Record<string, unknown>,
    Record<string, unknown>
  >({
    name: 'edge',
    through: {
      request: { needs: [], consumes: [], provides: [] },
      response: {
        needs: [responseKey, 'response.http.headers', 'response.usage.billable'],
        consumes: [],
        provides: [],
      },
    },
    execute: async (received, next) => await next(received),
  });
  const ending = defineStage<Record<string, unknown>, Record<string, unknown>>({
    name: 'ending',
    return: { provides: [responseKey, 'response.http.headers', 'response.usage.billable'] },
    execute: async received => {
      down = received;
      return move({ ...received, [responseKey]: answer, 'response.http.headers': [], 'response.usage.billable': [] });
    },
  });
  const { facts: up } = await run(compose('chain', [edge, ...(stages as never[]), ending]), move(facts) as never, {});
  return { down, up: up as Record<string, unknown> };
};

/** One stage is the same harness with an array of one. */
const runStage = async (
  stage: unknown,
  responseKey: string,
  facts: Record<string, unknown>,
  answer: unknown = { kind: 'value' as const, body: null },
): Promise<{ readonly down: Record<string, unknown>; readonly up: Record<string, unknown> }> =>
  await runChain(responseKey, [stage], facts, answer);

/** An answer in the shape a wire hands up: frames, read once. */
const streamOf = <TEvent>(frames: readonly ProtocolFrame<TEvent>[]) => ({
  kind: 'stream' as const,
  frames: { [Symbol.asyncIterator]: () => (async function* () { yield* frames; })() },
});

const drain = async <TEvent>(answer: unknown): Promise<ProtocolFrame<TEvent>[]> => {
  const collected: ProtocolFrame<TEvent>[] = [];
  for await (const frame of (answer as { frames: AsyncIterable<ProtocolFrame<TEvent>> }).frames) collected.push(frame);
  return collected;
};

const chatCompletionsPayload = (
  messages: ChatCompletionsPayload['messages'],
  rest: Partial<ChatCompletionsPayload> = {},
): ChatCompletionsPayload => ({ model: 'm', messages, ...rest }) as ChatCompletionsPayload;

const messagesPayload = (messages: unknown[], rest: Record<string, unknown> = {}): MessagesPayload =>
  ({ model: 'm', max_tokens: 16, messages, ...rest }) as unknown as MessagesPayload;

const responsesPayload = (input: unknown[], rest: Record<string, unknown> = {}): ResponsesPayload =>
  ({ model: 'm', input, ...rest }) as unknown as ResponsesPayload;

describe('the Chat Completions interceptors, as stages', () => {
  it('rewrites the roles its flags name, in the settled order', async () => {
    const { down } = await runStage(applyRoleCompatibilityToChatCompletions, 'response.chat.chatCompletions', {
      'request.chat.chatCompletions': chatCompletionsPayload([
        { role: 'system', content: 'lead' },
        { role: 'user', content: 'hi' },
        { role: 'system', content: 'mid' },
      ]),
      'route.attempt': attemptWith('rewrite-system-to-developer'),
    });
    const after = down['request.chat.chatCompletions'] as ChatCompletionsPayload;
    expect(after.messages.map(message => message.role)).toEqual(['developer', 'user', 'developer']);
  });

  it('turns only a mid-conversation system message into a user one', async () => {
    const { down } = await runStage(applyRoleCompatibilityToChatCompletions, 'response.chat.chatCompletions', {
      'request.chat.chatCompletions': chatCompletionsPayload([
        { role: 'system', content: 'lead' },
        { role: 'system', content: 'still lead' },
        { role: 'user', content: 'hi' },
        { role: 'system', content: 'mid' },
      ]),
      'route.attempt': attemptWith('rewrite-mid-conv-system-to-user'),
    });
    const after = down['request.chat.chatCompletions'] as ChatCompletionsPayload;
    expect(after.messages.map(message => message.role)).toEqual(['system', 'system', 'user', 'user']);
  });

  // The convention the whole exact-recording story rests on. A stage whose flags do not
  // fire must hand the payload back as the *same object*, or every layer costs a copy of
  // the conversation and the dump stops being affordable.
  it('hands the same payload back by identity when no flag fires', async () => {
    const original = chatCompletionsPayload([{ role: 'system', content: 'lead' }]);
    const { down } = await runStage(applyRoleCompatibilityToChatCompletions, 'response.chat.chatCompletions', {
      'request.chat.chatCompletions': original,
      'route.attempt': attemptWith(),
    });
    expect(down['request.chat.chatCompletions']).toBe(original);
  });

  it('hands the same payload back when a flag fires but changes nothing', async () => {
    const original = chatCompletionsPayload([{ role: 'user', content: 'hi' }]);
    const { down } = await runStage(applyRoleCompatibilityToChatCompletions, 'response.chat.chatCompletions', {
      'request.chat.chatCompletions': original,
      'route.attempt': attemptWith('rewrite-system-to-developer'),
    });
    expect(down['request.chat.chatCompletions']).toBe(original);
  });

  it('shares every message it did not rewrite', async () => {
    const messages = Array.from({ length: 49 }, (_, index) => (
      index === 0 ? { role: 'system' as const, content: 'lead' } : { role: 'user' as const, content: `turn ${index}` }
    ));
    const original = chatCompletionsPayload(messages);
    const { down } = await runStage(applyRoleCompatibilityToChatCompletions, 'response.chat.chatCompletions', {
      'request.chat.chatCompletions': original,
      'route.attempt': attemptWith('rewrite-system-to-developer'),
    });
    const after = down['request.chat.chatCompletions'] as ChatCompletionsPayload;
    const shared = after.messages.filter((message, index) => message === messages[index]).length;
    expect(shared).toBe(48);   // every message but the one that changed
  });

  it('disables reasoning only when a tool choice is forced', async () => {
    const { down: forced } = await runStage(disableReasoningOnForcedToolChoiceForChatCompletions, 'response.chat.chatCompletions', {
      'request.chat.chatCompletions': chatCompletionsPayload([], { tool_choice: 'required' }),
      'route.attempt': attemptWith('disable-reasoning-on-forced-tool-choice'),
    });
    expect((forced['request.chat.chatCompletions'] as ChatCompletionsPayload).reasoning_effort).toBe('none');

    const free = chatCompletionsPayload([], { tool_choice: 'auto' });
    const { down: untouched } = await runStage(disableReasoningOnForcedToolChoiceForChatCompletions, 'response.chat.chatCompletions', {
      'request.chat.chatCompletions': free,
      'route.attempt': attemptWith('disable-reasoning-on-forced-tool-choice'),
    });
    expect(untouched['request.chat.chatCompletions']).toBe(free);
  });

  it('removes the prompt cache key, and the key itself rather than its value', async () => {
    const { down } = await runStage(stripPromptCacheKeyForChatCompletions, 'response.chat.chatCompletions', {
      'request.chat.chatCompletions': chatCompletionsPayload([], { prompt_cache_key: 'k' } as Partial<ChatCompletionsPayload>),
      'route.attempt': attemptWith('strip-prompt-cache-key'),
    });
    const after = down['request.chat.chatCompletions'] as ChatCompletionsPayload;
    // `undefined` is not a removal: the key has to be gone, not present and empty.
    expect('prompt_cache_key' in after).toBe(false);
  });

  it('leaves a payload that never had the key alone, by identity', async () => {
    const original = chatCompletionsPayload([]);
    const { down } = await runStage(stripPromptCacheKeyForChatCompletions, 'response.chat.chatCompletions', {
      'request.chat.chatCompletions': original,
      'route.attempt': attemptWith('strip-prompt-cache-key'),
    });
    expect(down['request.chat.chatCompletions']).toBe(original);
  });

  // The usage chunk is what every stream here is billed from, so what the client asked for and
  // what the upstream is asked for differ — and this is the rule that makes them differ.
  it('asks the upstream for the usage chunk when the client sent no stream options', async () => {
    const { down } = await runStage(includeUsageStreamOptionsForChatCompletions, 'response.chat.chatCompletions', {
      'request.chat.chatCompletions': chatCompletionsPayload([]),
    });
    expect((down['request.chat.chatCompletions'] as ChatCompletionsPayload).stream_options).toEqual({ include_usage: true });
  });

  it('asks for it over a client that asked for it to be left out', async () => {
    const { down } = await runStage(includeUsageStreamOptionsForChatCompletions, 'response.chat.chatCompletions', {
      'request.chat.chatCompletions': chatCompletionsPayload([], { stream_options: { include_usage: false } }),
    });
    expect((down['request.chat.chatCompletions'] as ChatCompletionsPayload).stream_options).toEqual({ include_usage: true });
  });

  // Everything else on `stream_options` is the client's own. An upstream that reads a key our
  // typed surface does not name still gets it.
  it('keeps the client-s other stream options while it forces the one it wants', async () => {
    const { down } = await runStage(includeUsageStreamOptionsForChatCompletions, 'response.chat.chatCompletions', {
      'request.chat.chatCompletions': chatCompletionsPayload([], {
        stream_options: { extra: 'keep-me', include_usage: false } as unknown as ChatCompletionsPayload['stream_options'],
      }),
    });
    expect((down['request.chat.chatCompletions'] as ChatCompletionsPayload).stream_options)
      .toEqual({ extra: 'keep-me', include_usage: true });
  });

  it('leaves a payload that already asked for it alone, by identity', async () => {
    const original = chatCompletionsPayload([], { stream_options: { include_usage: true } });
    const { down } = await runStage(includeUsageStreamOptionsForChatCompletions, 'response.chat.chatCompletions', {
      'request.chat.chatCompletions': original,
    });
    expect(down['request.chat.chatCompletions']).toBe(original);
  });

  // The spec puts the final usage on a carrier chunk of its own; an upstream that hangs it off
  // the last delta is split in two so that everything downstream reads the one shape.
  it('moves usage off the chunk that carried the last delta and onto a carrier of its own', async () => {
    const { up } = await runStage(normalizeUsageForChatCompletions, 'response.chat.chatCompletions', {},
      streamOf<ChatCompletionsStreamEvent>([eventFrame({
        id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'm',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      } as unknown as ChatCompletionsStreamEvent)]));
    const frames = await drain<ChatCompletionsStreamEvent>(up['response.chat.chatCompletions']);

    expect(frames).toHaveLength(2);
    const delta = chatCompletionsEventOf(frames[0]!);
    expect(delta.choices).toEqual([{ index: 0, delta: {}, finish_reason: 'stop' }]);
    expect('usage' in delta).toBe(false);
    const carrier = chatCompletionsEventOf(frames[1]!);
    // The carrier is the same chunk otherwise: an id and a model a client can correlate.
    expect(carrier).toMatchObject({ id: 'c1', model: 'm', choices: [] });
    expect(carrier.usage).toEqual({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 });
  });

  it('hands a chunk that is already a carrier, and one with no usage at all, back by identity', async () => {
    const carrier = eventFrame({
      id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 60 } },
    } as unknown as ChatCompletionsStreamEvent);
    const content = eventFrame({
      id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'm',
      choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }],
    } as unknown as ChatCompletionsStreamEvent);
    const done = doneFrame();

    const { up } = await runStage(normalizeUsageForChatCompletions, 'response.chat.chatCompletions', {},
      streamOf<ChatCompletionsStreamEvent>([carrier, content, done]));
    const frames = await drain<ChatCompletionsStreamEvent>(up['response.chat.chatCompletions']);

    expect(frames).toEqual([carrier, content, done]);
  });

  // Naming a vendor's cache fields is the vendor stage's job, and it has already run by the
  // time the answer reaches this one. A chunk still carrying them is one no vendor claimed.
  it('leaves a vendor-s own cache fields where it found them', async () => {
    const { up } = await runStage(normalizeUsageForChatCompletions, 'response.chat.chatCompletions', {},
      streamOf<ChatCompletionsStreamEvent>([chatCompletionsUsageChunk({
        prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_cache_hit_tokens: 70, cached_tokens: 25,
      })]));
    const frames = await drain<ChatCompletionsStreamEvent>(up['response.chat.chatCompletions']);

    expect(chatCompletionsUsageOf(frames[0]!)).toEqual({
      prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_cache_hit_tokens: 70, cached_tokens: 25,
    });
  });

  // Verbatim from a Charm Hyper kimi-k3 turn: 479 + 13312 + 373 = 14164, so `prompt_tokens`
  // counts only what the cache did not serve, and `total_tokens` witnesses it whatever anyone
  // flagged.
  it('folds the cache buckets into the input total when the totals witness it', async () => {
    const { up } = await runStage(normalizeExclusiveCachedTokensForChatCompletions, 'response.chat.chatCompletions', {
      'route.attempt': attemptWith(),
    }, streamOf<ChatCompletionsStreamEvent>([chatCompletionsUsageChunk({
      prompt_tokens: 479, completion_tokens: 373, total_tokens: 14164, prompt_tokens_details: { cached_tokens: 13312 },
    })]));
    const frames = await drain<ChatCompletionsStreamEvent>(up['response.chat.chatCompletions']);

    expect(chatCompletionsUsageOf(frames[0]!)).toMatchObject({
      prompt_tokens: 13791,
      // The total already counted the real input, and now agrees with it.
      total_tokens: 14164,
      prompt_tokens_details: { cached_tokens: 13312 },
    });
  });

  // The flag settles the responses whose totals witness nothing, which makes it a declaration
  // input rather than the gate — and it arrives on the attempt this stage read on the way
  // down, so this is also what proves the closure carries it to the way back.
  it('folds on the flag alone when the chunk states no total, cache writes included', async () => {
    const { up } = await runStage(normalizeExclusiveCachedTokensForChatCompletions, 'response.chat.chatCompletions', {
      'route.attempt': attemptWith('usage-exclusive-cached-tokens'),
    }, streamOf<ChatCompletionsStreamEvent>([chatCompletionsUsageChunk({
      prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 120, cache_creation_input_tokens: 80 },
    })]));
    const frames = await drain<ChatCompletionsStreamEvent>(up['response.chat.chatCompletions']);

    expect(chatCompletionsUsageOf(frames[0]!)).toMatchObject({ prompt_tokens: 300 });
  });

  it('hands an inclusive chunk, and one with no cache counts, back by identity', async () => {
    const inclusive = chatCompletionsUsageChunk({
      prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050, prompt_tokens_details: { cached_tokens: 400 },
    });
    const uncached = chatCompletionsUsageChunk({ prompt_tokens: 40, completion_tokens: 1, total_tokens: 41 });

    const { up } = await runStage(normalizeExclusiveCachedTokensForChatCompletions, 'response.chat.chatCompletions', {
      'route.attempt': attemptWith('usage-exclusive-cached-tokens'),
    }, streamOf<ChatCompletionsStreamEvent>([uncached]));
    expect(await drain<ChatCompletionsStreamEvent>(up['response.chat.chatCompletions'])).toEqual([uncached]);

    const { up: unflagged } = await runStage(normalizeExclusiveCachedTokensForChatCompletions, 'response.chat.chatCompletions', {
      'route.attempt': attemptWith(),
    }, streamOf<ChatCompletionsStreamEvent>([inclusive]));
    expect(await drain<ChatCompletionsStreamEvent>(unflagged['response.chat.chatCompletions'])).toEqual([inclusive]);
  });

  // Both contradictions name the flag and the upstream, because the remedy is a setting an
  // operator makes on that upstream. Neither may pass silently: one over-charges the input by
  // the whole cached prefix, the other underflows it.
  it('raises when the flag claims exclusive and the totals say inclusive', async () => {
    const { up } = await runStage(normalizeExclusiveCachedTokensForChatCompletions, 'response.chat.chatCompletions', {
      'route.attempt': attemptWith('usage-exclusive-cached-tokens'),
    }, streamOf<ChatCompletionsStreamEvent>([chatCompletionsUsageChunk({
      prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050, prompt_tokens_details: { cached_tokens: 400 },
    })]));

    await expect(drain<ChatCompletionsStreamEvent>(up['response.chat.chatCompletions']))
      .rejects.toThrow(/usage-exclusive-cached-tokens is enabled/);
  });

  it('raises naming the flag when the cache counts underflow with no verdict', async () => {
    const { up } = await runStage(normalizeExclusiveCachedTokensForChatCompletions, 'response.chat.chatCompletions', {
      'route.attempt': attemptWith(),
    }, streamOf<ChatCompletionsStreamEvent>([chatCompletionsUsageChunk({
      prompt_tokens: 479, completion_tokens: 373, prompt_tokens_details: { cached_tokens: 13312 },
    })]));

    await expect(drain<ChatCompletionsStreamEvent>(up['response.chat.chatCompletions']))
      .rejects.toThrow(/enable usage-exclusive-cached-tokens/);
  });

  it('leaves an answer that is not a stream alone, by identity', async () => {
    const answer = { kind: 'value' as const, body: null };
    const { up } = await runStage(normalizeExclusiveCachedTokensForChatCompletions, 'response.chat.chatCompletions', {
      'route.attempt': attemptWith(),
    }, answer);
    expect(up['response.chat.chatCompletions']).toBe(answer);
  });
});

/** A `choices: []` carrier holding nothing but the counts under test — the shape the spec puts
 *  a stream's final usage on. */
const chatCompletionsUsageChunk = (usage: Record<string, unknown>): ProtocolFrame<ChatCompletionsStreamEvent> =>
  eventFrame({
    id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [], usage,
  } as unknown as ChatCompletionsStreamEvent);

const chatCompletionsEventOf = (frame: ProtocolFrame<ChatCompletionsStreamEvent>): Record<string, unknown> =>
  (frame as unknown as { event: Record<string, unknown> }).event;

const chatCompletionsUsageOf = (frame: ProtocolFrame<ChatCompletionsStreamEvent>): Record<string, unknown> =>
  chatCompletionsEventOf(frame).usage as Record<string, unknown>;

const deepSeekDelta = (delta: Record<string, unknown>): ProtocolFrame<ChatCompletionsStreamEvent> =>
  eventFrame({
    id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'm',
    choices: [{ index: 0, delta, finish_reason: null }],
  } as unknown as ChatCompletionsStreamEvent);

const deltaOf = (frame: ProtocolFrame<ChatCompletionsStreamEvent>): Record<string, unknown> =>
  (chatCompletionsEventOf(frame).choices as { delta: Record<string, unknown> }[])[0]!.delta;

/** An assistant turn as the gateway holds it: the canonical reasoning fields, and a tool call
 *  the replay of a multi-turn loop has to keep. */
const assistantReplay = (reasoning: Record<string, unknown>): ChatCompletionsPayload['messages'] => [
  { role: 'user', content: 'first turn' },
  {
    role: 'assistant', content: null, ...reasoning,
    tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{}' } }],
  },
  { role: 'tool', tool_call_id: 'call_1', content: 'result' },
] as unknown as ChatCompletionsPayload['messages'];

const assistantOf = (payload: unknown): Record<string, unknown> =>
  (payload as ChatCompletionsPayload).messages[1] as unknown as Record<string, unknown>;

describe('the Chat Completions vendor dialects, as stages', () => {
  it('projects the canonical assistant reasoning onto the one field DeepSeek reads', async () => {
    const { down } = await runStage(vendorDeepSeekNormalizeForChatCompletions, 'response.chat.chatCompletions', {
      'request.chat.chatCompletions': chatCompletionsPayload(assistantReplay({
        reasoning_text: 'let me check the docs',
        reasoning_opaque: 'opaque-blob',
        reasoning_items: [{ type: 'reasoning', summary: [] }],
      })),
      'route.attempt': attemptWith('vendor-deepseek'),
    });
    const assistant = assistantOf(down['request.chat.chatCompletions']);

    expect(assistant.reasoning_content).toBe('let me check the docs');
    // The other three are not DeepSeek's, and `reasoning_opaque` in particular is the
    // canonical cross-turn signature it does not accept.
    expect('reasoning_text' in assistant).toBe(false);
    expect('reasoning_opaque' in assistant).toBe(false);
    expect('reasoning_items' in assistant).toBe(false);
    expect(assistant.tool_calls).toHaveLength(1);
  });

  it('writes that field from the summary items when the scalar is the thing that is missing', async () => {
    const { down } = await runStage(vendorDeepSeekNormalizeForChatCompletions, 'response.chat.chatCompletions', {
      'request.chat.chatCompletions': chatCompletionsPayload(assistantReplay({
        reasoning_items: [{
          type: 'reasoning', id: 'rs_1',
          summary: [{ type: 'summary_text', text: 'step one. ' }, { type: 'summary_text', text: 'step two.' }],
        }],
      })),
      'route.attempt': attemptWith('vendor-deepseek'),
    });

    expect(assistantOf(down['request.chat.chatCompletions']).reasoning_content).toBe('step one. step two.');
  });

  it('strips the fields it cannot project even when there is nothing to project', async () => {
    const { down } = await runStage(vendorDeepSeekNormalizeForChatCompletions, 'response.chat.chatCompletions', {
      'request.chat.chatCompletions': chatCompletionsPayload([
        { role: 'user', content: 'first turn' },
        { role: 'assistant', content: 'answer', reasoning_items: [{ type: 'reasoning' }], reasoning_opaque: 'opaque-chain' },
      ] as unknown as ChatCompletionsPayload['messages']),
      'route.attempt': attemptWith('vendor-deepseek'),
    });
    const assistant = assistantOf(down['request.chat.chatCompletions']);

    expect('reasoning_content' in assistant).toBe(false);
    expect('reasoning_items' in assistant).toBe(false);
    expect('reasoning_opaque' in assistant).toBe(false);
    expect(assistant.content).toBe('answer');
  });

  it('puts the reasoning sentinel into the shape DeepSeek reads', async () => {
    const { down } = await runStage(vendorDeepSeekNormalizeForChatCompletions, 'response.chat.chatCompletions', {
      'request.chat.chatCompletions': chatCompletionsPayload([], { reasoning_effort: 'none' }),
      'route.attempt': attemptWith('vendor-deepseek'),
    });
    const after = down['request.chat.chatCompletions'] as Record<string, unknown>;

    expect('reasoning_effort' in after).toBe(false);
    expect(after.thinking).toEqual({ type: 'disabled' });
  });

  it('puts the reasoning sentinel into the shape Qwen reads', async () => {
    const { down } = await runStage(vendorQwenNormalizeForChatCompletions, 'response.chat.chatCompletions', {
      'request.chat.chatCompletions': chatCompletionsPayload([], { reasoning_effort: 'none' }),
      'route.attempt': attemptWith('vendor-qwen'),
    });
    const after = down['request.chat.chatCompletions'] as Record<string, unknown>;

    expect('reasoning_effort' in after).toBe(false);
    expect(after.enable_thinking).toBe(false);
  });

  // Only the sentinel means "no reasoning". A real effort is the client asking for reasoning,
  // and DeepSeek and Qwen both take it in the canonical field.
  it('leaves a payload that asked for real reasoning alone, by identity', async () => {
    const original = chatCompletionsPayload([], { reasoning_effort: 'high' });
    for (const stage of [vendorDeepSeekNormalizeForChatCompletions, vendorQwenNormalizeForChatCompletions]) {
      const { down } = await runStage(stage, 'response.chat.chatCompletions', {
        'request.chat.chatCompletions': original,
        'route.attempt': attemptWith('vendor-deepseek', 'vendor-qwen'),
      });
      expect(down['request.chat.chatCompletions']).toBe(original);
    }
  });

  // DeepSeek's structured output takes `json_object` and nothing else, so the schema goes
  // rather than the request being refused for carrying it.
  it('downgrades a JSON schema to the JSON object DeepSeek supports', async () => {
    const { down } = await runStage(vendorDeepSeekNormalizeForChatCompletions, 'response.chat.chatCompletions', {
      'request.chat.chatCompletions': chatCompletionsPayload([], {
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'messages_response', strict: true, schema: { type: 'object' } },
        },
      }),
      'route.attempt': attemptWith('vendor-deepseek'),
    });

    expect((down['request.chat.chatCompletions'] as ChatCompletionsPayload).response_format).toEqual({ type: 'json_object' });
  });

  it('leaves a payload already asking for a JSON object alone, by identity', async () => {
    const original = chatCompletionsPayload([], { response_format: { type: 'json_object' } });
    const { down } = await runStage(vendorDeepSeekNormalizeForChatCompletions, 'response.chat.chatCompletions', {
      'request.chat.chatCompletions': original,
      'route.attempt': attemptWith('vendor-deepseek'),
    });
    expect(down['request.chat.chatCompletions']).toBe(original);
  });

  it('renames DeepSeek-s reasoning deltas to the canonical field', async () => {
    const { up } = await runStage(vendorDeepSeekNormalizeForChatCompletions, 'response.chat.chatCompletions', {
      'request.chat.chatCompletions': chatCompletionsPayload([]),
      'route.attempt': attemptWith('vendor-deepseek'),
    }, streamOf<ChatCompletionsStreamEvent>([
      deepSeekDelta({ role: 'assistant' }),
      deepSeekDelta({ reasoning_content: 'thinking...' }),
      deepSeekDelta({ content: 'answer' }),
      doneFrame(),
    ]));
    const frames = await drain<ChatCompletionsStreamEvent>(up['response.chat.chatCompletions']);

    expect(deltaOf(frames[1]!).reasoning_text).toBe('thinking...');
    expect('reasoning_content' in deltaOf(frames[1]!)).toBe(false);
    // The deltas either side of it are not this rule's business.
    expect(deltaOf(frames[0]!)).toEqual({ role: 'assistant' });
    expect(deltaOf(frames[2]!)).toEqual({ content: 'answer' });
  });

  it('rewrites DeepSeek-s cache-hit count into the field the rules above it read', async () => {
    const { up } = await runStage(vendorDeepSeekNormalizeForChatCompletions, 'response.chat.chatCompletions', {
      'request.chat.chatCompletions': chatCompletionsPayload([]),
      'route.attempt': attemptWith('vendor-deepseek'),
    }, streamOf<ChatCompletionsStreamEvent>([chatCompletionsUsageChunk({
      prompt_tokens: 100, completion_tokens: 20, total_tokens: 120,
      prompt_cache_hit_tokens: 70, prompt_cache_miss_tokens: 30,
      prompt_tokens_details: { upstream_metric: 'preserved' },
    })]));
    const frames = await drain<ChatCompletionsStreamEvent>(up['response.chat.chatCompletions']);
    const usage = chatCompletionsUsageOf(frames[0]!);

    expect(usage.prompt_tokens).toBe(100);
    expect(usage.prompt_tokens_details).toEqual({ upstream_metric: 'preserved', cached_tokens: 70 });
    // The miss count is what is left of the input, which `prompt_tokens` already says.
    expect('prompt_cache_hit_tokens' in usage).toBe(false);
    expect('prompt_cache_miss_tokens' in usage).toBe(false);
  });

  it('rewrites Kimi-s flat cached count into that same field', async () => {
    const { up } = await runStage(vendorKimiNormalizeForChatCompletions, 'response.chat.chatCompletions', {
      'route.attempt': attemptWith('vendor-kimi'),
    }, streamOf<ChatCompletionsStreamEvent>([chatCompletionsUsageChunk({
      prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cached_tokens: 50,
      prompt_tokens_details: { upstream_metric: 'preserved' },
    })]));
    const frames = await drain<ChatCompletionsStreamEvent>(up['response.chat.chatCompletions']);
    const usage = chatCompletionsUsageOf(frames[0]!);

    expect(usage.prompt_tokens_details).toEqual({ upstream_metric: 'preserved', cached_tokens: 50 });
    expect('cached_tokens' in usage).toBe(false);
  });

  // An upstream that answers with an array where the details object should be is not carrying
  // details, so what goes on the rewritten block is the one count that was read — not the
  // array's own indices spread across it.
  it('replaces a details field that is not an object rather than spreading it', async () => {
    for (const [stage, flag, vendorField] of [
      [vendorDeepSeekNormalizeForChatCompletions, 'vendor-deepseek', 'prompt_cache_hit_tokens'],
      [vendorKimiNormalizeForChatCompletions, 'vendor-kimi', 'cached_tokens'],
    ] as const) {
      const { up } = await runStage(stage, 'response.chat.chatCompletions', {
        'request.chat.chatCompletions': chatCompletionsPayload([]),
        'route.attempt': attemptWith(flag),
      }, streamOf<ChatCompletionsStreamEvent>([chatCompletionsUsageChunk({
        prompt_tokens: 100, completion_tokens: 20, total_tokens: 120,
        [vendorField]: 70, prompt_tokens_details: [{ cached_tokens: 1 }],
      })]));
      const frames = await drain<ChatCompletionsStreamEvent>(up['response.chat.chatCompletions']);

      expect(chatCompletionsUsageOf(frames[0]!).prompt_tokens_details).toEqual({ cached_tokens: 70 });
    }
  });

  // A flag is data on an upstream model. A candidate that does not carry one is an upstream
  // whose wire is already canonical, and nothing here may touch it.
  it('stands down on a candidate that carries none of the vendor flags', async () => {
    const payload = chatCompletionsPayload([], { reasoning_effort: 'none' });
    const usage = chatCompletionsUsageChunk({
      prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_cache_hit_tokens: 70, cached_tokens: 50,
    });
    for (const stage of [
      vendorDeepSeekNormalizeForChatCompletions,
      vendorQwenNormalizeForChatCompletions,
      vendorKimiNormalizeForChatCompletions,
    ]) {
      const { down, up } = await runStage(stage, 'response.chat.chatCompletions', {
        'request.chat.chatCompletions': payload,
        'route.attempt': attemptWith(),
      }, streamOf<ChatCompletionsStreamEvent>([usage]));

      expect(down['request.chat.chatCompletions']).toBe(payload);
      expect(await drain<ChatCompletionsStreamEvent>(up['response.chat.chatCompletions'])).toEqual([usage]);
    }
  });

  // A stream that breaks is the upstream's failure and belongs to whoever is reading it; a
  // rewrite that swallowed it would present a broken turn as a whole one.
  it('lets an upstream stream failure through as it was thrown', async () => {
    const failure = new Error('upstream stream failed');
    for (const [stage, flag] of [
      [vendorDeepSeekNormalizeForChatCompletions, 'vendor-deepseek'],
      [vendorKimiNormalizeForChatCompletions, 'vendor-kimi'],
    ] as const) {
      const { up } = await runStage(stage, 'response.chat.chatCompletions', {
        'request.chat.chatCompletions': chatCompletionsPayload([]),
        'route.attempt': attemptWith(flag),
      }, { kind: 'stream' as const, frames: { [Symbol.asyncIterator]: () => (async function* () { throw failure; })() } });

      await expect(drain<ChatCompletionsStreamEvent>(up['response.chat.chatCompletions'])).rejects.toBe(failure);
    }
  });
});

describe('the Messages interceptors, as stages', () => {
  it('turns every inline system message into a user one', async () => {
    const { down } = await runStage(applyRoleCompatibilityToMessages, 'response.chat.messages', {
      'request.chat.messages': messagesPayload([
        { role: 'system', content: 'lead' },
        { role: 'user', content: 'hi' },
        { role: 'system', content: 'mid' },
      ]),
      'route.attempt': attemptWith('rewrite-mid-conv-system-to-user'),
    });
    const after = down['request.chat.messages'] as MessagesPayload;
    // The top-level `system` field is the only first-position slot on this protocol, so even
    // the leading one is past the leading run.
    expect(after.messages.map(message => message.role)).toEqual(['user', 'user', 'user']);
  });

  it('hands the same conversation back by identity when the flag does not fire', async () => {
    const original = messagesPayload([{ role: 'system', content: 'lead' }]);
    const { down } = await runStage(applyRoleCompatibilityToMessages, 'response.chat.messages', {
      'request.chat.messages': original,
      'route.attempt': attemptWith(),
    });
    expect(down['request.chat.messages']).toBe(original);
  });

  it('hands the same conversation back when the flag fires but there is no system message', async () => {
    const original = messagesPayload([{ role: 'user', content: 'hi' }]);
    const { down } = await runStage(applyRoleCompatibilityToMessages, 'response.chat.messages', {
      'request.chat.messages': original,
      'route.attempt': attemptWith('rewrite-mid-conv-system-to-user'),
    });
    expect(down['request.chat.messages']).toBe(original);
  });

  it('disables thinking on a forced tool choice and leaves the structured-output format', async () => {
    const { down } = await runStage(disableReasoningOnForcedToolChoiceForMessages, 'response.chat.messages', {
      'request.chat.messages': messagesPayload([], {
        tool_choice: { type: 'any' },
        output_config: { effort: 'high', format: { type: 'json_schema', schema: {} } },
      }),
      'route.attempt': attemptWith('disable-reasoning-on-forced-tool-choice'),
    });
    const after = down['request.chat.messages'] as MessagesPayload;
    expect(after.thinking).toEqual({ type: 'disabled' });
    // Forced tool choice composes fine with structured output; it is thinking it does not
    // compose with, so only the effort goes.
    expect(after.output_config).toEqual({ format: { type: 'json_schema', schema: {} } });
  });

  it('drops an output_config that held nothing but the effort', async () => {
    const { down } = await runStage(disableReasoningOnForcedToolChoiceForMessages, 'response.chat.messages', {
      'request.chat.messages': messagesPayload([], {
        tool_choice: { type: 'tool', name: 'f' },
        output_config: { effort: 'high' },
      }),
      'route.attempt': attemptWith('disable-reasoning-on-forced-tool-choice'),
    });
    expect('output_config' in (down['request.chat.messages'] as MessagesPayload)).toBe(false);
  });

  it('leaves a free tool choice alone, by identity', async () => {
    const free = messagesPayload([], { tool_choice: { type: 'auto' } });
    const { down } = await runStage(disableReasoningOnForcedToolChoiceForMessages, 'response.chat.messages', {
      'request.chat.messages': free,
      'route.attempt': attemptWith('disable-reasoning-on-forced-tool-choice'),
    });
    expect(down['request.chat.messages']).toBe(free);
  });

  it('scrubs the billing header line and the per-turn hash out of the system prompt', async () => {
    const { down } = await runStage(stripBillingAttributionFromMessages, 'response.chat.messages', {
      'request.chat.messages': messagesPayload([], {
        system: 'x-anthropic-billing-header: cch=abcdef12\nreal instructions\ncch=beef01;',
      }),
      'route.attempt': attemptWith('strip-billing-attribution'),
    });
    expect((down['request.chat.messages'] as MessagesPayload).system).toBe('real instructions');
  });

  it('drops a system block the scrub emptied, and the field when nothing is left', async () => {
    const { down } = await runStage(stripBillingAttributionFromMessages, 'response.chat.messages', {
      'request.chat.messages': messagesPayload([], {
        system: [{ type: 'text', text: 'x-anthropic-billing-header: cch=abcdef12' }],
      }),
      'route.attempt': attemptWith('strip-billing-attribution'),
    });
    // An empty system prompt is not a system prompt: the field goes rather than riding on
    // empty.
    expect('system' in (down['request.chat.messages'] as MessagesPayload)).toBe(false);
  });

  it('leaves a system prompt carrying no attribution block alone, by identity', async () => {
    const original = messagesPayload([], { system: [{ type: 'text', text: 'real instructions' }] });
    const { down } = await runStage(stripBillingAttributionFromMessages, 'response.chat.messages', {
      'request.chat.messages': original,
      'route.attempt': attemptWith('strip-billing-attribution'),
    });
    expect(down['request.chat.messages']).toBe(original);
  });
});

describe('the Gemini interceptors, as stages', () => {
  it('drops the part fields no translation carries, and a part they were all of', async () => {
    const { down } = await runStage(stripUnsupportedPartFieldsFromGemini, 'response.chat.gemini', {
      'request.chat.gemini': {
        contents: [{
          role: 'user',
          parts: [
            { text: 'hi', fileData: { mimeType: 'text/plain', fileUri: 'u' } },
            { fileData: { mimeType: 'text/plain', fileUri: 'u' } },
          ],
        }],
        systemInstruction: { parts: [{ text: 'sys', codeExecutionResult: {} }] },
      } satisfies GeminiPayload,
    });
    const after = down['request.chat.gemini'] as GeminiPayload;
    expect(after.contents?.[0]?.parts).toEqual([{ text: 'hi' }]);
    expect(after.systemInstruction?.parts).toEqual([{ text: 'sys' }]);
  });

  it('hands a payload carrying no unsupported part field back by identity', async () => {
    const original: GeminiPayload = { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] };
    const { down } = await runStage(stripUnsupportedPartFieldsFromGemini, 'response.chat.gemini', {
      'request.chat.gemini': original,
    });
    expect(down['request.chat.gemini']).toBe(original);
  });

  it('keeps a tool group only for its function declarations', async () => {
    const { down } = await runStage(stripUnsupportedToolsFromGemini, 'response.chat.gemini', {
      'request.chat.gemini': {
        tools: [{ functionDeclarations: [{ name: 'f' }], googleSearch: {} }, { codeExecution: {} }],
      } satisfies GeminiPayload,
    });
    expect((down['request.chat.gemini'] as GeminiPayload).tools).toEqual([{ functionDeclarations: [{ name: 'f' }] }]);
  });

  it('removes the tool list itself when no group declared a function', async () => {
    const { down } = await runStage(stripUnsupportedToolsFromGemini, 'response.chat.gemini', {
      'request.chat.gemini': { tools: [{ googleSearch: {} }] } satisfies GeminiPayload,
    });
    // An empty tool list is a different request from no tools at all.
    expect('tools' in (down['request.chat.gemini'] as GeminiPayload)).toBe(false);
  });

  it('hands a payload whose groups only declare functions back by identity', async () => {
    const original: GeminiPayload = { tools: [{ functionDeclarations: [{ name: 'f' }] }] };
    const { down } = await runStage(stripUnsupportedToolsFromGemini, 'response.chat.gemini', {
      'request.chat.gemini': original,
    });
    expect(down['request.chat.gemini']).toBe(original);
  });

  it('removes the safety settings, and leaves a payload that carries none alone', async () => {
    const { down } = await runStage(stripSafetySettingsFromGemini, 'response.chat.gemini', {
      'request.chat.gemini': { safetySettings: [{ category: 'c', threshold: 't' }] } satisfies GeminiPayload,
    });
    expect('safetySettings' in (down['request.chat.gemini'] as GeminiPayload)).toBe(false);

    const original: GeminiPayload = { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] };
    const { down: untouched } = await runStage(stripSafetySettingsFromGemini, 'response.chat.gemini', {
      'request.chat.gemini': original,
    });
    expect(untouched['request.chat.gemini']).toBe(original);
  });

  it('hides thought parts from a caller who did not opt in', async () => {
    const answer = streamOf<GeminiStreamEvent>([
      eventFrame({ candidates: [{ index: 0, content: { parts: [{ text: 'pondering', thought: true }] } }] }),
      eventFrame({
        candidates: [{
          index: 0,
          content: { parts: [{ text: 'more pondering', thought: true }, { text: 'the answer' }] },
          finishReason: 'STOP',
        }],
      }),
    ]);
    const { up } = await runStage(suppressThoughtPartsFromGemini, 'response.chat.gemini', {
      'request.chat.gemini': {} satisfies GeminiPayload,
    }, answer);
    const frames = await drain<GeminiStreamEvent>(up['response.chat.gemini']);
    // The first event was pure thought and had not finished, so it is nothing at all and
    // never reaches the client; the second keeps only what the caller asked for.
    expect(frames).toHaveLength(1);
    const event = (frames[0] as { event: Extract<GeminiStreamEvent, { candidates?: unknown }> }).event;
    expect(event.candidates?.[0]?.content.parts).toEqual([{ text: 'the answer' }]);
  });

  // The opt-in is something the client sent, so it is read on the way down and used on the
  // way back — the closure carrying it across is the only mechanism this proves.
  it('leaves the stream alone when the caller asked to see thoughts', async () => {
    const answer = streamOf<GeminiStreamEvent>([
      eventFrame({ candidates: [{ index: 0, content: { parts: [{ text: 'pondering', thought: true }] }, finishReason: 'STOP' }] }),
    ]);
    const { up } = await runStage(suppressThoughtPartsFromGemini, 'response.chat.gemini', {
      'request.chat.gemini': { generationConfig: { thinkingConfig: { includeThoughts: true } } } satisfies GeminiPayload,
    }, answer);
    expect(up['response.chat.gemini']).toBe(answer);
  });

  it('leaves an answer that is not a stream alone, by identity', async () => {
    const answer = { kind: 'value' as const, body: null };
    const { up } = await runStage(suppressThoughtPartsFromGemini, 'response.chat.gemini', {
      'request.chat.gemini': {} satisfies GeminiPayload,
    }, answer);
    expect(up['response.chat.gemini']).toBe(answer);
  });
});

describe('the Responses interceptors, as stages', () => {
  const rolesOf = (down: Record<string, unknown>): unknown[] =>
    ((down['request.chat.responses'] as ResponsesPayload).input as ResponsesInputItem[])
      .map(item => (item as { role?: unknown }).role);

  it('rewrites the roles its flags name, in the settled order', async () => {
    const { down } = await runStage(applyRoleCompatibilityToResponses, 'response.chat.responses', {
      'request.chat.responses': responsesPayload([
        { type: 'message', role: 'system', content: 'lead' },
        { type: 'message', role: 'user', content: 'hi' },
        { type: 'message', role: 'system', content: 'mid' },
      ]),
      'route.attempt': attemptWith('rewrite-system-to-developer'),
    });
    expect(rolesOf(down)).toEqual(['developer', 'user', 'developer']);
  });

  // The ordering the rule depends on: an item with no role of its own still ends the leading
  // system run, which is what makes the system message after it mid-conversation.
  it('lets an item carrying no role cross the leading system run', async () => {
    const { down } = await runStage(applyRoleCompatibilityToResponses, 'response.chat.responses', {
      'request.chat.responses': responsesPayload([
        { type: 'message', role: 'system', content: 'lead' },
        { type: 'reasoning', id: 'rs_1', summary: [] },
        { type: 'message', role: 'system', content: 'after' },
      ]),
      'route.attempt': attemptWith('rewrite-mid-conv-system-to-user'),
    });
    expect(rolesOf(down)).toEqual(['system', undefined, 'user']);
  });

  it('hands the same payload back by identity when no flag fires', async () => {
    const original = responsesPayload([{ type: 'message', role: 'system', content: 'lead' }]);
    const { down } = await runStage(applyRoleCompatibilityToResponses, 'response.chat.responses', {
      'request.chat.responses': original,
      'route.attempt': attemptWith(),
    });
    expect(down['request.chat.responses']).toBe(original);
  });

  it('disables reasoning on a required tool choice and on a named one', async () => {
    for (const toolChoice of ['required', { type: 'function', name: 'f' }]) {
      const { down } = await runStage(disableReasoningOnForcedToolChoiceForResponses, 'response.chat.responses', {
        'request.chat.responses': responsesPayload([], { tool_choice: toolChoice, reasoning: { effort: 'high', summary: 'auto' } }),
        'route.attempt': attemptWith('disable-reasoning-on-forced-tool-choice'),
      });
      // The object is replaced rather than merged: a summary has nothing to summarize once
      // reasoning is off.
      expect((down['request.chat.responses'] as ResponsesPayload).reasoning).toEqual({ effort: 'none' });
    }
  });

  it('leaves an automatic tool choice alone, by identity', async () => {
    const free = responsesPayload([], { tool_choice: 'auto' });
    const { down } = await runStage(disableReasoningOnForcedToolChoiceForResponses, 'response.chat.responses', {
      'request.chat.responses': free,
      'route.attempt': attemptWith('disable-reasoning-on-forced-tool-choice'),
    });
    expect(down['request.chat.responses']).toBe(free);
  });

  it('removes the prompt cache key, and leaves a payload that never had it alone', async () => {
    const { down } = await runStage(stripPromptCacheKeyForResponses, 'response.chat.responses', {
      'request.chat.responses': responsesPayload([], { prompt_cache_key: 'k' }),
      'route.attempt': attemptWith('strip-prompt-cache-key'),
    });
    expect('prompt_cache_key' in (down['request.chat.responses'] as ResponsesPayload)).toBe(false);

    const original = responsesPayload([]);
    const { down: untouched } = await runStage(stripPromptCacheKeyForResponses, 'response.chat.responses', {
      'request.chat.responses': original,
      'route.attempt': attemptWith('strip-prompt-cache-key'),
    });
    expect(untouched['request.chat.responses']).toBe(original);
  });

  it('folds the cache buckets into the input total when the totals witness it', async () => {
    // 100 + 50 + 10 = 160 reaches the stated total and 100 + 10 does not, so the upstream
    // reports the buckets outside the input count whatever anyone flagged.
    const answer = streamOf<ResponsesStreamEvent>([usageEvent({ input_tokens: 100, output_tokens: 10, total_tokens: 160, input_tokens_details: { cached_tokens: 50 } })]);
    const { up } = await runStage(normalizeExclusiveCachedTokensForResponses, 'response.chat.responses', {
      'route.attempt': attemptWith(),
    }, answer);
    const frames = await drain<ResponsesStreamEvent>(up['response.chat.responses']);
    expect(usageOf(frames[0]!)).toMatchObject({ input_tokens: 150, output_tokens: 10 });
  });

  // The flag settles the responses whose totals witness nothing, which makes it a declaration
  // input rather than the gate — and it arrives on the attempt this stage read on the way
  // down, so this is also what proves the closure carries it to the way back.
  it('folds on the flag alone when the response states no total', async () => {
    const answer = streamOf<ResponsesStreamEvent>([usageEvent({ input_tokens: 100, output_tokens: 10, input_tokens_details: { cached_tokens: 50, cache_write_tokens: 5 } })]);
    const { up } = await runStage(normalizeExclusiveCachedTokensForResponses, 'response.chat.responses', {
      'route.attempt': attemptWith('usage-exclusive-cached-tokens'),
    }, answer);
    const frames = await drain<ResponsesStreamEvent>(up['response.chat.responses']);
    expect(usageOf(frames[0]!)).toMatchObject({ input_tokens: 155 });
  });

  it('hands a frame back by identity when the totals say the buckets are already inside', async () => {
    const frame = usageEvent({ input_tokens: 100, output_tokens: 10, total_tokens: 110, input_tokens_details: { cached_tokens: 50 } });
    const { up } = await runStage(normalizeExclusiveCachedTokensForResponses, 'response.chat.responses', {
      'route.attempt': attemptWith(),
    }, streamOf<ResponsesStreamEvent>([frame]));
    const frames = await drain<ResponsesStreamEvent>(up['response.chat.responses']);
    expect(frames[0]).toBe(frame);
  });

  it('leaves an answer that is not a stream alone, by identity', async () => {
    const answer = { kind: 'value' as const, body: null };
    const { up } = await runStage(normalizeExclusiveCachedTokensForResponses, 'response.chat.responses', {
      'route.attempt': attemptWith(),
    }, answer);
    expect(up['response.chat.responses']).toBe(answer);
  });

  it('puts the reasoning sentinel into the shape DeepSeek reads', async () => {
    const { down } = await runStage(vendorDeepSeekNormalizeForResponses, 'response.chat.responses', {
      'request.chat.responses': responsesPayload([], { reasoning: { effort: 'none' } }),
      'route.attempt': attemptWith('vendor-deepseek'),
    });
    const after = down['request.chat.responses'] as Record<string, unknown>;
    expect('reasoning' in after).toBe(false);
    expect(after.thinking).toEqual({ type: 'disabled' });
  });

  it('puts the reasoning sentinel into the shape Qwen reads', async () => {
    const { down } = await runStage(vendorQwenNormalizeForResponses, 'response.chat.responses', {
      'request.chat.responses': responsesPayload([], { reasoning: { effort: 'none' } }),
      'route.attempt': attemptWith('vendor-qwen'),
    });
    const after = down['request.chat.responses'] as Record<string, unknown>;
    expect('reasoning' in after).toBe(false);
    expect(after.enable_thinking).toBe(false);
  });

  it('leaves the sentinel alone for an upstream that is not Qwen', async () => {
    // The dialect is the flag's, not the payload's: the same sentinel means something else on
    // the next upstream, and a rewrite that fired without the flag would put a Qwen field on a
    // wire that has never heard of it.
    const original = responsesPayload([], { reasoning: { effort: 'none' } });
    const { down } = await runStage(vendorQwenNormalizeForResponses, 'response.chat.responses', {
      'request.chat.responses': original,
      'route.attempt': attemptWith(),
    });
    expect(down['request.chat.responses']).toBe(original);
  });

  it('leaves a payload that asked for real reasoning alone, by identity', async () => {
    const original = responsesPayload([], { reasoning: { effort: 'high' } });
    for (const stage of [vendorDeepSeekNormalizeForResponses, vendorQwenNormalizeForResponses]) {
      const { down } = await runStage(stage, 'response.chat.responses', {
        'request.chat.responses': original,
        'route.attempt': attemptWith('vendor-deepseek', 'vendor-qwen'),
      });
      expect(down['request.chat.responses']).toBe(original);
    }
  });
});

/** A lifecycle envelope carrying nothing but the counts under test. Every event that carries
 *  a response resource repeats the whole resource, which is why the rewrite is per event. */
const usageEvent = (usage: Record<string, unknown>): ProtocolFrame<ResponsesStreamEvent> =>
  eventFrame({ type: 'response.completed', sequence_number: 0, response: { usage } } as unknown as ResponsesStreamEvent);

const usageOf = (frame: ProtocolFrame<ResponsesStreamEvent>): Record<string, unknown> =>
  (frame as { event: { response: { usage: Record<string, unknown> } } }).event.response.usage;

// Each array below is the order a family's chain runs these rules in, and running it is what
// says the order is a property of the array rather than of any one stage: assembly refuses
// declarations that do not line up, and a rewrite that had to see another rewrite's output
// only sees it from where it sits.
//
// It is not that family's *whole* chain. Rules a wire owns run in the wire's own chain, below
// the stage that picks it, so what an array states is the order of what sits above the fork.
describe('a family\'s interceptor array, in the order its chain runs it', () => {
  it('assembles and runs the Messages array', async () => {
    const { down } = await runChain('response.chat.messages', [
      stripBillingAttributionFromMessages,
      disableReasoningOnForcedToolChoiceForMessages,
      applyRoleCompatibilityToMessages,
    ], {
      'request.chat.messages': messagesPayload([{ role: 'system', content: 'inline' }], {
        system: 'x-anthropic-billing-header: cch=abcdef12\nreal instructions',
        tool_choice: { type: 'any' },
      }),
      'route.attempt': attemptWith(
        'strip-billing-attribution',
        'disable-reasoning-on-forced-tool-choice',
        'rewrite-mid-conv-system-to-user',
      ),
    });
    const after = down['request.chat.messages'] as MessagesPayload;
    expect(after.system).toBe('real instructions');
    expect(after.thinking).toEqual({ type: 'disabled' });
    expect(after.messages.map(message => message.role)).toEqual(['user']);
  });

  it('assembles and runs the Gemini array', async () => {
    const answer = streamOf<GeminiStreamEvent>([
      eventFrame({ candidates: [{ index: 0, content: { parts: [{ text: 'pondering', thought: true }, { text: 'the answer' }] }, finishReason: 'STOP' }] }),
    ]);
    const { down, up } = await runChain('response.chat.gemini', [
      stripUnsupportedPartFieldsFromGemini,
      stripUnsupportedToolsFromGemini,
      stripSafetySettingsFromGemini,
      suppressThoughtPartsFromGemini,
    ], {
      'request.chat.gemini': {
        contents: [{ role: 'user', parts: [{ text: 'hi', fileData: { mimeType: 'text/plain', fileUri: 'u' } }] }],
        tools: [{ googleSearch: {} }],
        safetySettings: [{ category: 'c', threshold: 't' }],
      } satisfies GeminiPayload,
    }, answer);
    const after = down['request.chat.gemini'] as GeminiPayload;
    expect(after.contents?.[0]?.parts).toEqual([{ text: 'hi' }]);
    expect('tools' in after).toBe(false);
    expect('safetySettings' in after).toBe(false);
    const frames = await drain<GeminiStreamEvent>(up['response.chat.gemini']);
    const event = (frames[0] as { event: Extract<GeminiStreamEvent, { candidates?: unknown }> }).event;
    expect(event.candidates?.[0]?.content.parts).toEqual([{ text: 'the answer' }]);
  });

  // The one ordering between stages rather than inside one: the sentinel is the gateway's
  // canonical form, and a vendor normalizer can only put it on the wire in the vendor's shape
  // because it runs after the stage that wrote it.
  it('assembles and runs the Responses array, the vendor normalizers last', async () => {
    const answer = streamOf<ResponsesStreamEvent>([usageEvent({ input_tokens: 100, output_tokens: 10, total_tokens: 160, input_tokens_details: { cached_tokens: 50 } })]);
    const { down, up } = await runChain('response.chat.responses', [
      disableReasoningOnForcedToolChoiceForResponses,
      applyRoleCompatibilityToResponses,
      stripPromptCacheKeyForResponses,
      normalizeExclusiveCachedTokensForResponses,
      vendorDeepSeekNormalizeForResponses,
      vendorQwenNormalizeForResponses,
    ], {
      'request.chat.responses': responsesPayload([
        { type: 'message', role: 'system', content: 'lead' },
        { type: 'message', role: 'user', content: 'hi' },
        { type: 'message', role: 'system', content: 'mid' },
      ], { tool_choice: 'required', prompt_cache_key: 'k' }),
      'route.attempt': attemptWith(
        'disable-reasoning-on-forced-tool-choice',
        'rewrite-mid-conv-system-to-user',
        'strip-prompt-cache-key',
        'vendor-deepseek',
      ),
    }, answer);
    const after = down['request.chat.responses'] as Record<string, unknown>;
    expect(rolesOfPayload(after)).toEqual(['system', 'user', 'user']);
    expect('prompt_cache_key' in after).toBe(false);
    // The sentinel this chain wrote reached DeepSeek's normalizer and left in DeepSeek's shape.
    expect('reasoning' in after).toBe(false);
    expect(after.thinking).toEqual({ type: 'disabled' });
    const frames = await drain<ResponsesStreamEvent>(up['response.chat.responses']);
    expect(usageOf(frames[0]!)).toMatchObject({ input_tokens: 150 });
  });

  // The Chat Completions wire's own array, which is not one family's: every source protocol
  // that reaches an upstream over this endpoint runs it. What the order states is one thing in
  // each direction. Going down, the usage chunk is asked for before any vendor can rewrite the
  // body. Coming back, the vendor dialect has the first say — so the fold reads a cache count
  // under OpenAI's name rather than DeepSeek's, and the carrier split reads the folded total.
  it('assembles and runs the Chat Completions wire, the vendor dialects innermost', async () => {
    const answer = streamOf<ChatCompletionsStreamEvent>([eventFrame({
      id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'm',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      // DeepSeek's own names, and the exclusive convention: 479 + 13312 + 373 = 14164.
      usage: {
        prompt_tokens: 479, completion_tokens: 373, total_tokens: 14164,
        prompt_cache_hit_tokens: 13312, prompt_cache_miss_tokens: 479,
      },
    } as unknown as ChatCompletionsStreamEvent)]);
    const { down, up } = await runChain('response.chat.chatCompletions', [
      includeUsageStreamOptionsForChatCompletions,
      normalizeUsageForChatCompletions,
      applyRoleCompatibilityToChatCompletions,
      normalizeExclusiveCachedTokensForChatCompletions,
      vendorDeepSeekNormalizeForChatCompletions,
      vendorQwenNormalizeForChatCompletions,
      vendorKimiNormalizeForChatCompletions,
    ], {
      'request.chat.chatCompletions': chatCompletionsPayload([
        { role: 'system', content: 'lead' },
        { role: 'user', content: 'hi' },
        { role: 'system', content: 'mid' },
      ], { reasoning_effort: 'none' }),
      'route.attempt': attemptWith('rewrite-mid-conv-system-to-user', 'vendor-deepseek'),
    }, answer);

    const sent = down['request.chat.chatCompletions'] as Record<string, unknown>;
    expect(sent.stream_options).toEqual({ include_usage: true });
    expect((sent as unknown as ChatCompletionsPayload).messages.map(message => message.role)).toEqual(['system', 'user', 'user']);
    // The sentinel this chain carried reached DeepSeek's dialect and left in DeepSeek's shape.
    expect('reasoning_effort' in sent).toBe(false);
    expect(sent.thinking).toEqual({ type: 'disabled' });

    const frames = await drain<ChatCompletionsStreamEvent>(up['response.chat.chatCompletions']);
    // Three rules ran on the way back, in the order that makes each one's input the one it
    // expects: the vendor rename, then the fold, then the split onto a carrier.
    expect(frames).toHaveLength(2);
    expect('usage' in chatCompletionsEventOf(frames[0]!)).toBe(false);
    expect(chatCompletionsUsageOf(frames[1]!)).toMatchObject({
      prompt_tokens: 13791,
      prompt_tokens_details: { cached_tokens: 13312 },
    });
  });
});

const rolesOfPayload = (payload: Record<string, unknown>): unknown[] =>
  (payload.input as ResponsesInputItem[]).map(item => (item as { role?: unknown }).role);
