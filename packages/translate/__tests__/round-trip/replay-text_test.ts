import { describe, expect, it } from 'vitest';

import { computeAnthropicMessagesTurnDigest, verifyAnthropicMessagesTurnDigest, type AnthropicMessagesAssistantTurn } from '../../src/protocols/anthropic-messages/as-source/round-trip.ts';
import { computeGeminiGenerateContentTurnDigest, verifyGeminiGenerateContentTurnDigest, type GeminiGenerateContentAssistantTurn } from '../../src/protocols/gemini-generate-content/as-source/round-trip.ts';
import { computeOpenAIChatCompletionsTurnDigest, verifyOpenAIChatCompletionsTurnDigest, type OpenAIChatCompletionsAssistantTurn } from '../../src/protocols/openai-chat-completions/as-source/round-trip.ts';
import { computeOpenAIResponsesTurnDigest, verifyOpenAIResponsesTurnDigest, type OpenAIResponsesAssistantTurn } from '../../src/protocols/openai-responses/as-source/round-trip.ts';

describe('semantic replay text channels', () => {
  it('merges Chat text across ignored metadata while keeping refusal separate', async () => {
    const split: OpenAIChatCompletionsAssistantTurn = { role: 'assistant', content: [{ type: 'text', text: 'hel' }, { type: 'text', text: 'lo' }] };
    const merged: OpenAIChatCompletionsAssistantTurn = { role: 'assistant', content: [{ type: 'text', text: 'hello' }] };
    const before = structuredClone(split);
    expect(await verifyOpenAIChatCompletionsTurnDigest(merged, await computeOpenAIChatCompletionsTurnDigest(split), 1)).toBe(true);
    expect(await verifyOpenAIChatCompletionsTurnDigest(split, await computeOpenAIChatCompletionsTurnDigest(merged), 1)).toBe(true);
    expect(split).toEqual(before);
    const interrupted: OpenAIChatCompletionsAssistantTurn = { role: 'assistant', content: [{ type: 'text', text: 'hel' }, { type: 'refusal', refusal: 'no' }, { type: 'text', text: 'lo' }] };
    expect(await verifyOpenAIChatCompletionsTurnDigest({ role: 'assistant', content: [{ type: 'text', text: 'hello' }, { type: 'refusal', refusal: 'no' }] }, await computeOpenAIChatCompletionsTurnDigest(interrupted), 1)).toBe(true);
    expect(await verifyOpenAIChatCompletionsTurnDigest({ role: 'assistant', content: [{ type: 'text', text: 'hellono' }] }, await computeOpenAIChatCompletionsTurnDigest(interrupted), 1)).toBe(false);
  });

  it('merges Messages text with empty citations within one message', async () => {
    const split: AnthropicMessagesAssistantTurn = [{ role: 'assistant', content: [{ type: 'text', text: 'hel', citations: null }, { type: 'text', text: 'lo', citations: [] }] }];
    const merged: AnthropicMessagesAssistantTurn = [{ role: 'assistant', content: [{ type: 'text', text: 'hello' }] }];
    expect(await verifyAnthropicMessagesTurnDigest(merged, await computeAnthropicMessagesTurnDigest(split), 1)).toBe(true);
    expect(await verifyAnthropicMessagesTurnDigest(split, await computeAnthropicMessagesTurnDigest(merged), 1)).toBe(true);
    const separate: AnthropicMessagesAssistantTurn = [{ role: 'assistant', content: 'hel' }, { role: 'assistant', content: 'lo' }];
    expect(await verifyAnthropicMessagesTurnDigest(merged, await computeAnthropicMessagesTurnDigest(separate), 1)).toBe(false);
  });

  it('merges Messages text across citations, cache metadata and tool blocks', async () => {
    const citation = { type: 'char_location' as const, cited_text: 'source', document_index: 0, document_title: null, start_char_index: 0, end_char_index: 6 };
    const cited: AnthropicMessagesAssistantTurn = [{ role: 'assistant', content: [{ type: 'text', text: 'hel', citations: [citation] }, { type: 'text', text: 'lo' }] }];
    const merged: AnthropicMessagesAssistantTurn = [{ role: 'assistant', content: [{ type: 'text', text: 'hello', citations: [citation] }] }];
    expect(await verifyAnthropicMessagesTurnDigest(merged, await computeAnthropicMessagesTurnDigest(cited), 1)).toBe(true);
    const cached: AnthropicMessagesAssistantTurn = [{ role: 'assistant', content: [{ type: 'text', text: 'hel', cache_control: { type: 'ephemeral' } }, { type: 'text', text: 'lo' }] }];
    expect(await verifyAnthropicMessagesTurnDigest([{ role: 'assistant', content: 'hello' }], await computeAnthropicMessagesTurnDigest(cached), 1)).toBe(true);
    const tool = { type: 'tool_use' as const, id: 'call', name: 'lookup', input: {} };
    const interrupted: AnthropicMessagesAssistantTurn = [{ role: 'assistant', content: [{ type: 'text', text: 'hel' }, tool, { type: 'text', text: 'lo' }] }];
    expect(await verifyAnthropicMessagesTurnDigest([{ role: 'assistant', content: [{ type: 'text', text: 'hello' }, tool] }], await computeAnthropicMessagesTurnDigest(interrupted), 1)).toBe(true);
  });

  it('keeps Messages nontext channels inside their owning message', async () => {
    const thinking = { type: 'thinking' as const, thinking: 'thought', signature: 'signature' };
    const tool = { type: 'tool_use' as const, id: 'call', name: 'lookup', input: {} };
    const original: AnthropicMessagesAssistantTurn = [
      { role: 'assistant', content: [{ type: 'text', text: 'A' }, thinking, tool] },
      { role: 'assistant', content: [{ type: 'text', text: 'B' }] },
    ];
    const check = await computeAnthropicMessagesTurnDigest(original);
    expect(await verifyAnthropicMessagesTurnDigest([
      { role: 'assistant', content: [{ type: 'text', text: 'A' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'B' }, thinking, tool] },
    ], check, 1)).toBe(false);
  });

  it('merges Responses text by channel while retaining item boundaries', async () => {
    const split: OpenAIResponsesAssistantTurn = [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'hel', annotations: [], logprobs: [] }, { type: 'output_text', text: 'lo', annotations: [] }] }];
    const merged: OpenAIResponsesAssistantTurn = [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'hello' }] }];
    expect(await verifyOpenAIResponsesTurnDigest(merged, await computeOpenAIResponsesTurnDigest(split), 1)).toBe(true);
    expect(await verifyOpenAIResponsesTurnDigest(split, await computeOpenAIResponsesTurnDigest(merged), 1)).toBe(true);
    const interrupted: OpenAIResponsesAssistantTurn = [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hel' }, { type: 'refusal', refusal: 'no' }, { type: 'output_text', text: 'lo' }] }];
    expect(await verifyOpenAIResponsesTurnDigest([{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello' }, { type: 'refusal', refusal: 'no' }] }], await computeOpenAIResponsesTurnDigest(interrupted), 1)).toBe(true);
    expect(await verifyOpenAIResponsesTurnDigest([{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hellono' }] }], await computeOpenAIResponsesTurnDigest(interrupted), 1)).toBe(false);
    const separate: OpenAIResponsesAssistantTurn = [{ type: 'message', role: 'assistant', status: 'completed', content: 'hel' }, { type: 'message', role: 'assistant', status: 'completed', content: 'lo' }];
    expect(await verifyOpenAIResponsesTurnDigest(merged, await computeOpenAIResponsesTurnDigest(separate), 1)).toBe(false);
  });

  it('ignores Responses annotations and logprobs when comparing text channels', async () => {
    const annotation = { type: 'url_citation' as const, start_index: 0, end_index: 3, title: 'source', url: 'https://example.test' };
    const logprob = { token: 'hel', logprob: -0.1, bytes: [104, 101, 108], top_logprobs: [] };
    for (const metadata of [{ annotations: [annotation] }, { logprobs: [logprob] }]) {
      const split: OpenAIResponsesAssistantTurn = [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hel', ...metadata }, { type: 'output_text', text: 'lo' }] }];
      expect(await verifyOpenAIResponsesTurnDigest([{ type: 'message', role: 'assistant', content: 'hello' }], await computeOpenAIResponsesTurnDigest(split), 1)).toBe(true);
    }
  });

  it('merges reasoning parts only within the same Responses item and channel', async () => {
    const split: OpenAIResponsesAssistantTurn = [{ type: 'reasoning', summary: [{ type: 'summary_text', text: 'hel' }, { type: 'summary_text', text: 'lo' }], content: [{ type: 'reasoning_text', text: 'think' }, { type: 'reasoning_text', text: 'ing' }] }];
    const merged: OpenAIResponsesAssistantTurn = [{ type: 'reasoning', summary: [{ type: 'summary_text', text: 'hello' }], content: [{ type: 'reasoning_text', text: 'thinking' }] }];
    expect(await verifyOpenAIResponsesTurnDigest(merged, await computeOpenAIResponsesTurnDigest(split), 1)).toBe(true);
    expect(await verifyOpenAIResponsesTurnDigest(split, await computeOpenAIResponsesTurnDigest(merged), 1)).toBe(true);
    expect(await verifyOpenAIResponsesTurnDigest([{ type: 'reasoning', summary: [{ type: 'summary_text', text: 'hellothinking' }] }], await computeOpenAIResponsesTurnDigest(split), 1)).toBe(false);
    expect(await verifyOpenAIResponsesTurnDigest([{ type: 'reasoning', summary: [{ type: 'summary_text', text: 'hel' }] }, { type: 'reasoning', summary: [{ type: 'summary_text', text: 'lo' }] }], await computeOpenAIResponsesTurnDigest([{ type: 'reasoning', summary: [{ type: 'summary_text', text: 'hello' }] }]), 1)).toBe(false);
  });

  it('merges visible Gemini text across ignored metadata and nontext parts within one Content', async () => {
    const merged: GeminiGenerateContentAssistantTurn = [{ role: 'model', parts: [{ text: 'hello' }] }];
    const split: GeminiGenerateContentAssistantTurn = [{ role: 'model', parts: [{ text: 'hel' }, { text: 'lo' }] }];
    expect(await verifyGeminiGenerateContentTurnDigest(merged, await computeGeminiGenerateContentTurnDigest(split), 1)).toBe(true);
    expect(await verifyGeminiGenerateContentTurnDigest(split, await computeGeminiGenerateContentTurnDigest(merged), 1)).toBe(true);
    for (const metadata of [{ thought: false }, { thoughtSignature: 'native-signature' }]) {
      expect(await verifyGeminiGenerateContentTurnDigest(merged, await computeGeminiGenerateContentTurnDigest([{ role: 'model', parts: [{ text: 'hel', ...metadata }, { text: 'lo' }] }]), 1)).toBe(true);
    }
    expect(await verifyGeminiGenerateContentTurnDigest(merged, await computeGeminiGenerateContentTurnDigest([{ role: 'model', parts: [{ text: 'hel' }] }, { role: 'model', parts: [{ text: 'lo' }] }]), 1)).toBe(false);
    const image = { inlineData: { mimeType: 'image/png', data: 'AQID' } };
    expect(await verifyGeminiGenerateContentTurnDigest([{ role: 'model', parts: [{ text: 'hello' }, image] }], await computeGeminiGenerateContentTurnDigest([{ role: 'model', parts: [{ text: 'hel' }, image, { text: 'lo' }] }]), 1)).toBe(true);
  });

  it('keeps Gemini nontext channels inside their owning Content', async () => {
    const call = { functionCall: { name: 'lookup', args: { q: 'x' } } };
    const image = { inlineData: { mimeType: 'image/png', data: 'AQID' } };
    const original: GeminiGenerateContentAssistantTurn = [
      { role: 'model', parts: [{ text: 'A' }, call, image] },
      { role: 'model', parts: [{ text: 'B' }] },
    ];
    const check = await computeGeminiGenerateContentTurnDigest(original);
    expect(await verifyGeminiGenerateContentTurnDigest([
      { role: 'model', parts: [{ text: 'A' }] },
      { role: 'model', parts: [{ text: 'B' }, call, image] },
    ], check, 1)).toBe(false);
  });

  it('uses UTF-16 concatenation even when a part boundary splits a surrogate pair', async () => {
    const first = 'prefix \ud83d';
    const second = '\ude00 suffix';
    expect(await verifyGeminiGenerateContentTurnDigest([{ parts: [{ text: first + second }] }], await computeGeminiGenerateContentTurnDigest([{ parts: [{ text: first }, { text: second }] }]), 1)).toBe(true);
  });
});
