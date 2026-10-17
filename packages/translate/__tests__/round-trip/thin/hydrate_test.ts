import { describe, expect, it, vi } from 'vitest';

import type { AnthropicMessagesThinAssistantTurn } from '../../../src/protocols/anthropic-messages/as-target/assistant-turn.ts';
import type { GeminiGenerateContentThinAssistantTurn } from '../../../src/protocols/gemini-generate-content/as-target/assistant-turn.ts';
import type { OpenAIChatCompletionsThinAssistantTurn } from '../../../src/protocols/openai-chat-completions/as-target/assistant-turn.ts';
import { hashRoundTripContent } from '../../../src/round-trip/replay-check.ts';
import { hydrateAssistantTurn } from '../../../src/round-trip/thin/hydrate.ts';
import { ThinReference } from '../../../src/round-trip/thin/reference.ts';
import { rawJSON } from '../../../src/shared/json/raw-json.ts';

describe('hydrateAssistantTurn', () => {
  it('keeps ordinary reference-shaped JSON objects and literal arrays as data', async () => {
    const input = {
      restoration: 'text', parts: [0], nested: [0, [0, 1, 2]],
      object: { restoration: 'json', parts: [[0, 0, 1]] },
    };
    const turn: AnthropicMessagesThinAssistantTurn<ThinReference> = {
      role: 'assistant', content: [{ type: 'tool_use', id: 'call', name: 'echo', input }],
    };
    const before = structuredClone(turn);
    const blocks = turn.content;
    const block = blocks[0];
    const nested = input.nested;
    const object = input.object;
    const hydrated = await hydrateAssistantTurn('anthropicMessages', [], turn);
    if (!hydrated.ok) throw new Error('Expected a literal assistant turn');
    expect(hydrated.turn).toBe(turn);
    expect(hydrated.turn.content).toBe(blocks);
    expect(hydrated.turn.content[0]).toBe(block);
    if (block.type !== 'tool_use') throw new Error('Expected a tool block');
    expect(block.input).toBe(input);
    expect(input.nested).toBe(nested);
    expect(input.object).toBe(object);
    expect(turn).toEqual(before);
  });

  it('reuses a literal array root and all nested containers', async () => {
    const part = { text: 'unchanged' };
    const parts = [part];
    const content = { role: 'model' as const, parts };
    const turn: GeminiGenerateContentThinAssistantTurn<ThinReference> = [content];
    const hydrated = await hydrateAssistantTurn('geminiGenerateContent', [], turn);
    if (!hydrated.ok) throw new Error('Expected a literal assistant turn');
    expect(hydrated.turn).toBe(turn);
    expect(hydrated.turn[0]).toBe(content);
    expect(hydrated.turn[0].parts).toBe(parts);
    expect(hydrated.turn[0].parts?.[0]).toBe(part);
  });

  it('restores text and JSON reference leaves in place while retaining their containers', async () => {
    const candidate = { value: 1, nested: { label: 'restored' } };
    const text = { type: 'text' as const, text: new ThinReference('text', [[0, 1, 7]]), citations: null };
    const tool = { type: 'tool_use' as const, id: 'call', name: 'lookup', input: new ThinReference('json', [1]) };
    const blocks = [text, tool];
    const turn: AnthropicMessagesThinAssistantTurn<ThinReference> = { role: 'assistant', content: blocks };
    const hydrated = await hydrateAssistantTurn('anthropicMessages', ['[answer]', candidate], turn, [
      await hashRoundTripContent('[answer]'), await hashRoundTripContent(JSON.stringify(candidate)),
    ]);
    if (!hydrated.ok) throw new Error('Expected reference hydration');
    expect(hydrated.turn).toBe(turn);
    expect(hydrated.turn.content).toBe(blocks);
    expect(hydrated.turn.content[0]).toBe(text);
    expect(hydrated.turn.content[1]).toBe(tool);
    expect(text.text).toBe('answer');
    expect(tool.input).toEqual(candidate);
    expect(tool.input).not.toBe(candidate);
  });

  it('preserves raw JSON and byte atom identities inside the consumed turn', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const number = rawJSON.rawJSON('9007199254740993');
    const metadata = { bytes, number, nested: [{ restoration: 'text', parts: [0] }] };
    const nested = metadata.nested;
    const ordinary = nested[0];
    const turn: OpenAIChatCompletionsThinAssistantTurn<ThinReference> = {
      role: 'assistant', content: new ThinReference('text', [0]), provider_specific_fields: metadata,
    };
    const hydrated = await hydrateAssistantTurn('openaiChatCompletions', ['answer'], turn, [await hashRoundTripContent('answer')]);
    if (!hydrated.ok) throw new Error('Expected reference hydration');
    expect(hydrated.turn).toBe(turn);
    expect(hydrated.turn.content).toBe('answer');
    expect(hydrated.turn.provider_specific_fields).toBe(metadata);
    expect(metadata.bytes).toBe(bytes);
    expect(metadata.number).toBe(number);
    expect(metadata.nested).toBe(nested);
    expect(metadata.nested[0]).toBe(ordinary);
    expect(bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(JSON.stringify(number)).toBe('9007199254740993');
  });

  it('does not hash candidates when a full turn has no referenced contents', async () => {
    const turn: OpenAIChatCompletionsThinAssistantTurn<ThinReference> = { role: 'assistant', content: 'unchanged' };
    const digest = vi.spyOn(crypto.subtle, 'digest');
    try {
      expect(await hydrateAssistantTurn('openaiChatCompletions', ['unused candidate'], turn)).toEqual({ ok: true, turn });
      expect(digest).not.toHaveBeenCalled();
    } finally {
      digest.mockRestore();
    }
  });

  it.each([{ payload: [] }, { payload: [0] }])('rejects an authenticated text reference without referenced contents: $payload', async ({ payload }) => {
    const turn: OpenAIChatCompletionsThinAssistantTurn<ThinReference> = {
      role: 'assistant',
      content: new ThinReference('text', payload),
    };
    await expect(hydrateAssistantTurn('openaiChatCompletions', ['answer'], turn)).rejects.toThrow('Thin reference requires referenced contents');
  });

  it('fails the whole turn when a referenced candidate is missing', async () => {
    const turn: OpenAIChatCompletionsThinAssistantTurn<ThinReference> = {
      role: 'assistant',
      content: new ThinReference('text', [0]),
    };
    expect(await hydrateAssistantTurn('openaiChatCompletions', [], turn, [await hashRoundTripContent('answer')])).toEqual({ ok: false, reason: 'missing-reference' });
  });

  it('propagates malformed JSON reference errors', async () => {
    const turn: AnthropicMessagesThinAssistantTurn<ThinReference> = {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'call', name: 'lookup', input: new ThinReference('json', [0]) }],
    };
    await expect(hydrateAssistantTurn('anthropicMessages', ['{'], turn, [await hashRoundTripContent('{')])).rejects.toThrow();
  });

  it('propagates authenticated hash-index invariant failures', async () => {
    const turn: OpenAIChatCompletionsThinAssistantTurn<ThinReference> = {
      role: 'assistant',
      content: new ThinReference('text', [1]),
    };
    await expect(hydrateAssistantTurn('openaiChatCompletions', ['answer'], turn, [await hashRoundTripContent('answer')])).rejects.toThrow();
  });
});
