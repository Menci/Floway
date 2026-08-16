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
  normalizeExclusiveCachedTokensForResponses,
  stripBillingAttributionFromMessages,
  stripPromptCacheKeyForChatCompletions,
  stripPromptCacheKeyForResponses,
  stripSafetySettingsFromGemini,
  stripUnsupportedPartFieldsFromGemini,
  stripUnsupportedToolsFromGemini,
  suppressThoughtPartsFromGemini,
  vendorDeepSeekNormalizeForResponses,
  vendorQwenNormalizeForResponses,
} from '../../src/data-plane/chat/interceptors.ts';
import type { AttemptSelector } from '../../src/data-plane/pipeline/facts.ts';
import { compose, defineStage, move, run } from '@floway-dev/pipeline';
import type { ChatCompletionsPayload } from '@floway-dev/protocols/chat-completions';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
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

// Each array below is the order that family's chain runs, and running it is what says the
// order is a property of the array rather than of any one stage: assembly refuses
// declarations that do not line up, and a rewrite that had to see another rewrite's output
// only sees it from where it sits.
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
});

const rolesOfPayload = (payload: Record<string, unknown>): unknown[] =>
  (payload.input as ResponsesInputItem[]).map(item => (item as { role?: unknown }).role);
