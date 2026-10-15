import { Tag } from 'cbor-x';
import { describe, expect, it, vi } from 'vitest';

import type { AnthropicMessagesThinAssistantTurn } from '../../../src/protocols/anthropic-messages/as-target/assistant-turn.ts';
import type { OpenAIChatCompletionsThinAssistantTurn } from '../../../src/protocols/openai-chat-completions/as-target/assistant-turn.ts';
import { hashRoundTripContent } from '../../../src/round-trip/replay-check.ts';
import { THIN_TAGS, type JSONReference, type TextReference, type ThinReference } from '../../../src/round-trip/thin/assistant-turn.ts';
import { hydrateAssistantTurn } from '../../../src/round-trip/thin/hydrate.ts';

describe('hydrateAssistantTurn', () => {
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
      content: new Tag(payload, THIN_TAGS.text) as TextReference,
    };
    await expect(hydrateAssistantTurn('openaiChatCompletions', ['answer'], turn)).rejects.toThrow('Thin reference requires referenced contents');
  });

  it('fails the whole turn when a referenced candidate is missing', async () => {
    const turn: OpenAIChatCompletionsThinAssistantTurn<ThinReference> = {
      role: 'assistant',
      content: new Tag([0], THIN_TAGS.text) as TextReference,
    };
    expect(await hydrateAssistantTurn('openaiChatCompletions', [], turn, [await hashRoundTripContent('answer')])).toEqual({ ok: false, reason: 'missing-reference' });
  });

  it('propagates malformed JSON reference errors', async () => {
    const turn: AnthropicMessagesThinAssistantTurn<ThinReference> = {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'call', name: 'lookup', input: new Tag([0], THIN_TAGS.json) as JSONReference }],
    };
    await expect(hydrateAssistantTurn('anthropicMessages', ['{'], turn, [await hashRoundTripContent('{')])).rejects.toThrow();
  });

  it('propagates authenticated hash-index invariant failures', async () => {
    const turn: OpenAIChatCompletionsThinAssistantTurn<ThinReference> = {
      role: 'assistant',
      content: new Tag([1], THIN_TAGS.text) as TextReference,
    };
    await expect(hydrateAssistantTurn('openaiChatCompletions', ['answer'], turn, [await hashRoundTripContent('answer')])).rejects.toThrow();
  });
});
