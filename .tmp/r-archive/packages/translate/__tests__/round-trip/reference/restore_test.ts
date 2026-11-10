import { describe, expect, it, vi } from 'vitest';

import type { AnthropicMessagesReferenceableAssistantTurn } from '../../../src/protocols/anthropic-messages/as-target/assistant-turn.ts';
import type { GeminiGenerateContentReferenceableAssistantTurn } from '../../../src/protocols/gemini-generate-content/as-target/assistant-turn.ts';
import type { OpenAIChatCompletionsReferenceableAssistantTurn } from '../../../src/protocols/openai-chat-completions/as-target/assistant-turn.ts';
import { ContentReference } from '../../../src/round-trip/reference/assistant-turn.ts';
import { restoreAssistantTurn } from '../../../src/round-trip/reference/restore.ts';
import { hashRoundTripContent } from '../../../src/round-trip/turn-digest.ts';
import { rawJSON } from '../../../src/shared/json/raw-json.ts';

describe('restoreAssistantTurn', () => {
  it('keeps ordinary reference-shaped JSON objects and literal arrays as data', async () => {
    const input = {
      kind: 'text', parts: [0], nested: [0, [0, 1, 2]],
      object: { kind: 'json', parts: [[0, 0, 1]] },
    };
    const turn: AnthropicMessagesReferenceableAssistantTurn<ContentReference> = {
      role: 'assistant', content: [{ type: 'tool_use', id: 'call', name: 'echo', input }],
    };
    const before = structuredClone(turn);
    const blocks = turn.content;
    const block = blocks[0];
    const nested = input.nested;
    const object = input.object;
    const hydrated = await restoreAssistantTurn('anthropicMessages', [], turn);
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
    const turn: GeminiGenerateContentReferenceableAssistantTurn<ContentReference> = [content];
    const hydrated = await restoreAssistantTurn('geminiGenerateContent', [], turn);
    if (!hydrated.ok) throw new Error('Expected a literal assistant turn');
    expect(hydrated.turn).toBe(turn);
    expect(hydrated.turn[0]).toBe(content);
    expect(hydrated.turn[0].parts).toBe(parts);
    expect(hydrated.turn[0].parts?.[0]).toBe(part);
  });

  it('restores text and JSON reference leaves in place while retaining their containers', async () => {
    const candidate = { value: 1, nested: { label: 'restored' } };
    const text = { type: 'text' as const, text: new ContentReference('text', [[0, 1, 7]]), citations: null };
    const tool = { type: 'tool_use' as const, id: 'call', name: 'lookup', input: new ContentReference('json', [1]) };
    const blocks = [text, tool];
    const turn: AnthropicMessagesReferenceableAssistantTurn<ContentReference> = { role: 'assistant', content: blocks };
    const hydrated = await restoreAssistantTurn('anthropicMessages', ['[answer]', candidate], turn, [
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
    const metadata = { bytes, number, nested: [{ kind: 'text', parts: [0] }] };
    const nested = metadata.nested;
    const ordinary = nested[0];
    const turn: OpenAIChatCompletionsReferenceableAssistantTurn<ContentReference> = {
      role: 'assistant', content: new ContentReference('text', [0]), provider_specific_fields: metadata,
    };
    const hydrated = await restoreAssistantTurn('openaiChatCompletions', ['answer'], turn, [await hashRoundTripContent('answer')]);
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
    const turn: OpenAIChatCompletionsReferenceableAssistantTurn<ContentReference> = { role: 'assistant', content: 'unchanged' };
    const digest = vi.spyOn(crypto.subtle, 'digest');
    try {
      expect(await restoreAssistantTurn('openaiChatCompletions', ['unused candidate'], turn)).toEqual({ ok: true, turn });
      expect(digest).not.toHaveBeenCalled();
    } finally {
      digest.mockRestore();
    }
  });

  it.each([{ payload: [] }, { payload: [0] }])('rejects an authenticated text reference without referenced contents: $payload', async ({ payload }) => {
    const turn: OpenAIChatCompletionsReferenceableAssistantTurn<ContentReference> = {
      role: 'assistant',
      content: new ContentReference('text', payload),
    };
    await expect(restoreAssistantTurn('openaiChatCompletions', ['answer'], turn)).rejects.toThrow('Thin reference requires referenced contents');
  });

  it('fails the whole turn when a referenced candidate is missing', async () => {
    const turn: OpenAIChatCompletionsReferenceableAssistantTurn<ContentReference> = {
      role: 'assistant',
      content: new ContentReference('text', [0]),
    };
    expect(await restoreAssistantTurn('openaiChatCompletions', [], turn, [await hashRoundTripContent('answer')])).toEqual({ ok: false, reason: 'missing-reference' });
  });

  it('propagates malformed JSON reference errors', async () => {
    const turn: AnthropicMessagesReferenceableAssistantTurn<ContentReference> = {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'call', name: 'lookup', input: new ContentReference('json', [0]) }],
    };
    await expect(restoreAssistantTurn('anthropicMessages', ['{'], turn, [await hashRoundTripContent('{')])).rejects.toThrow();
  });

  it('propagates authenticated hash-index invariant failures', async () => {
    const turn: OpenAIChatCompletionsReferenceableAssistantTurn<ContentReference> = {
      role: 'assistant',
      content: new ContentReference('text', [1]),
    };
    await expect(restoreAssistantTurn('openaiChatCompletions', ['answer'], turn, [await hashRoundTripContent('answer')])).rejects.toThrow();
  });
});
