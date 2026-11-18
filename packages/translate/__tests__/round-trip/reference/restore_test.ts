import { describe, expect, it } from 'vitest';

import type { AnthropicMessagesReferenceableInputAssistantTurn } from '../../../src/protocols/anthropic-messages/as-target/assistant-turn.ts';
import type { OpenAIChatCompletionsReferenceableInputAssistantTurn } from '../../../src/protocols/openai-chat-completions/as-target/assistant-turn.ts';
import { hashRoundTripContent } from '../../../src/round-trip/hash.ts';
import { restoreAssistantTurn } from '../../../src/round-trip/reference/restore.ts';
import { ContentReference } from '../../../src/round-trip/reference/types.ts';

describe('restoreAssistantTurn', () => {
  it('keeps ordinary reference-shaped JSON objects and literal arrays as data', async () => {
    const input = {
      kind: 'text', parts: [0], nested: [0, [0, 1, 2]],
      object: { kind: 'json', parts: [[0, 0, 1]] },
    };
    const turn: AnthropicMessagesReferenceableInputAssistantTurn<ContentReference> = {
      role: 'assistant', content: [{ type: 'tool_use', id: 'call', name: 'echo', input }],
    };
    const before = structuredClone(turn);
    const blocks = turn.content;
    const block = blocks[0];
    const nested = input.nested;
    const object = input.object;
    const hydrated = await restoreAssistantTurn('anthropicMessages', [], turn);
    if (!hydrated.ok) throw new Error('Expected a literal assistant turn');
    expect(hydrated.value).toBe(turn);
    expect(hydrated.value.content).toBe(blocks);
    expect(hydrated.value.content[0]).toBe(block);
    if (block.type !== 'tool_use') throw new Error('Expected a tool block');
    expect(block.input).toBe(input);
    expect(input.nested).toBe(nested);
    expect(input.object).toBe(object);
    expect(turn).toEqual(before);
  });

  it('restores text and JSON reference leaves in place while retaining their containers', async () => {
    const candidate = { value: 1, nested: { label: 'restored' } };
    const text = { type: 'text' as const, text: new ContentReference('text', [[0, 1, 7]]), citations: null };
    const tool = { type: 'tool_use' as const, id: 'call', name: 'lookup', input: new ContentReference('json', [1]) };
    const blocks = [text, tool];
    const turn: AnthropicMessagesReferenceableInputAssistantTurn<ContentReference> = { role: 'assistant', content: blocks };
    const hydrated = await restoreAssistantTurn('anthropicMessages', ['[answer]', candidate], turn, [
      await hashRoundTripContent('[answer]'), await hashRoundTripContent(JSON.stringify(candidate)),
    ]);
    if (!hydrated.ok) throw new Error('Expected reference hydration');
    expect(hydrated.value).toBe(turn);
    expect(hydrated.value.content).toBe(blocks);
    expect(hydrated.value.content[0]).toBe(text);
    expect(hydrated.value.content[1]).toBe(tool);
    expect(text.text).toBe('answer');
    expect(tool.input).toEqual(candidate);
    expect(tool.input).not.toBe(candidate);
  });

  it('rejects an authenticated text reference without referenced contents', async () => {
    const turn: OpenAIChatCompletionsReferenceableInputAssistantTurn<ContentReference> = {
      role: 'assistant',
      content: new ContentReference('text', [0]),
    };
    await expect(restoreAssistantTurn('openaiChatCompletions', ['answer'], turn)).rejects.toThrow('Thin reference requires referenced contents');
  });

  it('fails the whole turn when a referenced candidate is missing', async () => {
    const turn: OpenAIChatCompletionsReferenceableInputAssistantTurn<ContentReference> = {
      role: 'assistant',
      content: new ContentReference('text', [0]),
    };
    expect(await restoreAssistantTurn('openaiChatCompletions', [], turn, [await hashRoundTripContent('answer')])).toEqual({ ok: false, reason: 'missing-reference' });
  });

});
