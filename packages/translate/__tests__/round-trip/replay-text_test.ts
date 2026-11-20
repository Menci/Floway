import { describe, expect, it } from 'vitest';

import { computeAnthropicMessagesTurnDigest, verifyAnthropicMessagesTurnDigest, type AnthropicMessagesSourceAssistantTurn } from '../../src/protocols/anthropic-messages/as-source/round-trip.ts';
import { computeGeminiGenerateContentTurnDigest, verifyGeminiGenerateContentTurnDigest, type GeminiGenerateContentSourceAssistantTurn } from '../../src/protocols/gemini-generate-content/as-source/round-trip.ts';
import { computeOpenAIChatCompletionsTurnDigest, verifyOpenAIChatCompletionsTurnDigest, type OpenAIChatCompletionsSourceAssistantTurn } from '../../src/protocols/openai-chat-completions/as-source/round-trip.ts';
import { computeOpenAIResponsesTurnDigest, verifyOpenAIResponsesTurnDigest, type OpenAIResponsesSourceAssistantTurn } from '../../src/protocols/openai-responses/as-source/round-trip.ts';

describe('semantic replay text channels', () => {
  it('merges Chat text across ignored metadata while keeping refusal separate', async () => {
    const split: OpenAIChatCompletionsSourceAssistantTurn = { role: 'assistant', content: [{ type: 'text', text: 'hel' }, { type: 'text', text: 'lo' }] };
    const merged: OpenAIChatCompletionsSourceAssistantTurn = { role: 'assistant', content: [{ type: 'text', text: 'hello' }] };
    const before = structuredClone(split);
    expect(await verifyOpenAIChatCompletionsTurnDigest(merged, await computeOpenAIChatCompletionsTurnDigest(split), 1)).toBe(true);
    expect(await verifyOpenAIChatCompletionsTurnDigest(split, await computeOpenAIChatCompletionsTurnDigest(merged), 1)).toBe(true);
    expect(split).toEqual(before);
    const interrupted: OpenAIChatCompletionsSourceAssistantTurn = { role: 'assistant', content: [{ type: 'text', text: 'hel' }, { type: 'refusal', refusal: 'no' }, { type: 'text', text: 'lo' }] };
    expect(await verifyOpenAIChatCompletionsTurnDigest({ role: 'assistant', content: [{ type: 'text', text: 'hello' }, { type: 'refusal', refusal: 'no' }] }, await computeOpenAIChatCompletionsTurnDigest(interrupted), 1)).toBe(true);
    expect(await verifyOpenAIChatCompletionsTurnDigest({ role: 'assistant', content: [{ type: 'text', text: 'hellono' }] }, await computeOpenAIChatCompletionsTurnDigest(interrupted), 1)).toBe(false);
  });

  it('merges Messages text across citations, cache metadata and tool blocks', async () => {
    const citation = { type: 'char_location' as const, cited_text: 'source', document_index: 0, document_title: null, start_char_index: 0, end_char_index: 6 };
    const cited: AnthropicMessagesSourceAssistantTurn = [{ role: 'assistant', content: [{ type: 'text', text: 'hel', citations: [citation] }, { type: 'text', text: 'lo' }] }];
    const merged: AnthropicMessagesSourceAssistantTurn = [{ role: 'assistant', content: [{ type: 'text', text: 'hello', citations: [citation] }] }];
    expect(await verifyAnthropicMessagesTurnDigest(merged, await computeAnthropicMessagesTurnDigest(cited), 1)).toBe(true);
    const cached: AnthropicMessagesSourceAssistantTurn = [{ role: 'assistant', content: [{ type: 'text', text: 'hel', cache_control: { type: 'ephemeral' } }, { type: 'text', text: 'lo' }] }];
    expect(await verifyAnthropicMessagesTurnDigest([{ role: 'assistant', content: 'hello' }], await computeAnthropicMessagesTurnDigest(cached), 1)).toBe(true);
    const tool = { type: 'tool_use' as const, id: 'call', name: 'lookup', input: {} };
    const interrupted: AnthropicMessagesSourceAssistantTurn = [{ role: 'assistant', content: [{ type: 'text', text: 'hel' }, tool, { type: 'text', text: 'lo' }] }];
    expect(await verifyAnthropicMessagesTurnDigest([{ role: 'assistant', content: [{ type: 'text', text: 'hello' }, tool] }], await computeAnthropicMessagesTurnDigest(interrupted), 1)).toBe(true);
  });

  it('merges Responses text by channel while retaining item boundaries', async () => {
    const split: OpenAIResponsesSourceAssistantTurn = [{ type: 'message', id: 'message-split', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'hel', annotations: [], logprobs: [] }, { type: 'output_text', text: 'lo', annotations: [] }] }];
    const merged: OpenAIResponsesSourceAssistantTurn = [{ type: 'message', id: 'message-merged', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'hello' }] }];
    expect(await verifyOpenAIResponsesTurnDigest(merged, await computeOpenAIResponsesTurnDigest(split), 1)).toBe(true);
    expect(await verifyOpenAIResponsesTurnDigest(split, await computeOpenAIResponsesTurnDigest(merged), 1)).toBe(true);
    const interrupted: OpenAIResponsesSourceAssistantTurn = [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hel' }, { type: 'refusal', refusal: 'no' }, { type: 'output_text', text: 'lo' }] }];
    expect(await verifyOpenAIResponsesTurnDigest([{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello' }, { type: 'refusal', refusal: 'no' }] }], await computeOpenAIResponsesTurnDigest(interrupted), 1)).toBe(true);
    expect(await verifyOpenAIResponsesTurnDigest([{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hellono' }] }], await computeOpenAIResponsesTurnDigest(interrupted), 1)).toBe(false);
    const separate: OpenAIResponsesSourceAssistantTurn = [{ type: 'message', id: 'message-hel', role: 'assistant', status: 'completed', content: 'hel' }, { type: 'message', id: 'message-lo', role: 'assistant', status: 'completed', content: 'lo' }];
    expect(await verifyOpenAIResponsesTurnDigest(merged, await computeOpenAIResponsesTurnDigest(separate), 1)).toBe(false);
  });

  it('merges visible Gemini text across ignored metadata and nontext parts within one Content', async () => {
    const merged: GeminiGenerateContentSourceAssistantTurn = [{ role: 'model', parts: [{ text: 'hello' }] }];
    const split: GeminiGenerateContentSourceAssistantTurn = [{ role: 'model', parts: [{ text: 'hel' }, { text: 'lo' }] }];
    expect(await verifyGeminiGenerateContentTurnDigest(merged, await computeGeminiGenerateContentTurnDigest(split), 1)).toBe(true);
    expect(await verifyGeminiGenerateContentTurnDigest(split, await computeGeminiGenerateContentTurnDigest(merged), 1)).toBe(true);
    for (const metadata of [{ thought: false }, { thoughtSignature: 'native-signature' }]) {
      expect(await verifyGeminiGenerateContentTurnDigest(merged, await computeGeminiGenerateContentTurnDigest([{ role: 'model', parts: [{ text: 'hel', ...metadata }, { text: 'lo' }] }]), 1)).toBe(true);
    }
    expect(await verifyGeminiGenerateContentTurnDigest(merged, await computeGeminiGenerateContentTurnDigest([{ role: 'model', parts: [{ text: 'hel' }] }, { role: 'model', parts: [{ text: 'lo' }] }]), 1)).toBe(false);
    const image = { inlineData: { mimeType: 'image/png', data: 'AQID' } };
    expect(await verifyGeminiGenerateContentTurnDigest([{ role: 'model', parts: [{ text: 'hello' }, image] }], await computeGeminiGenerateContentTurnDigest([{ role: 'model', parts: [{ text: 'hel' }, image, { text: 'lo' }] }]), 1)).toBe(true);
  });

});
