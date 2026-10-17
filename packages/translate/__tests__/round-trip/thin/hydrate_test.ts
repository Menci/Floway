import { describe, expect, it, vi } from 'vitest';

import type { AnthropicMessagesThinAssistantTurn } from '../../../src/protocols/anthropic-messages/as-target/assistant-turn.ts';
import type { OpenAIChatCompletionsThinAssistantTurn } from '../../../src/protocols/openai-chat-completions/as-target/assistant-turn.ts';
import { hashRoundTripContent } from '../../../src/round-trip/replay-check.ts';
import { hydrateAssistantTurn } from '../../../src/round-trip/thin/hydrate.ts';
import { ThinReference } from '../../../src/round-trip/thin/reference.ts';

describe('hydrateAssistantTurn', () => {
  it('keeps ordinary reference-shaped JSON objects and literal arrays as data', async () => {
    const input = {
      restoration: 'text', parts: [0], nested: [0, [0, 1, 2]],
      object: { restoration: 'json', parts: [[0, 0, 1]] },
    };
    const turn: AnthropicMessagesThinAssistantTurn<ThinReference> = {
      role: 'assistant', content: [{ type: 'tool_use', id: 'call', name: 'echo', input }],
    };
    expect(await hydrateAssistantTurn('anthropicMessages', [], turn)).toEqual({ ok: true, turn });
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
