import { describe, expect, it } from 'vitest';

import { computeAnthropicMessagesReplayCheck, verifyAnthropicMessagesReplayCheck, type AnthropicMessagesAssistantTurn } from '../../src/protocols/anthropic-messages/as-source/round-trip.ts';
import { computeGeminiGenerateContentReplayCheck, verifyGeminiGenerateContentReplayCheck, type GeminiGenerateContentAssistantTurn } from '../../src/protocols/gemini-generate-content/as-source/round-trip.ts';
import { computeOpenAIChatCompletionsReplayCheck, verifyOpenAIChatCompletionsReplayCheck, type OpenAIChatCompletionsAssistantTurn } from '../../src/protocols/openai-chat-completions/as-source/round-trip.ts';
import { computeOpenAIResponsesReplayCheck, verifyOpenAIResponsesReplayCheck, type OpenAIResponsesAssistantTurn } from '../../src/protocols/openai-responses/as-source/round-trip.ts';

describe('semantic replay text channels', () => {
  it('merges Chat text across ignored metadata while keeping refusal separate', async () => {
    const split: OpenAIChatCompletionsAssistantTurn = { role: 'assistant', content: [{ type: 'text', text: 'hel' }, { type: 'text', text: 'lo' }] };
    const merged: OpenAIChatCompletionsAssistantTurn = { role: 'assistant', content: [{ type: 'text', text: 'hello' }] };
    const before = structuredClone(split);
    expect(await verifyOpenAIChatCompletionsReplayCheck(merged, await computeOpenAIChatCompletionsReplayCheck(split))).toBe(true);
    expect(await verifyOpenAIChatCompletionsReplayCheck(split, await computeOpenAIChatCompletionsReplayCheck(merged))).toBe(true);
    expect(split).toEqual(before);
    const interrupted: OpenAIChatCompletionsAssistantTurn = { role: 'assistant', content: [{ type: 'text', text: 'hel' }, { type: 'refusal', refusal: 'no' }, { type: 'text', text: 'lo' }] };
    expect(await verifyOpenAIChatCompletionsReplayCheck({ role: 'assistant', content: [{ type: 'text', text: 'hello' }, { type: 'refusal', refusal: 'no' }] }, await computeOpenAIChatCompletionsReplayCheck(interrupted))).toBe(true);
    expect(await verifyOpenAIChatCompletionsReplayCheck({ role: 'assistant', content: [{ type: 'text', text: 'hellono' }] }, await computeOpenAIChatCompletionsReplayCheck(interrupted))).toBe(false);
  });

  it('merges Messages text with empty citations within one message', async () => {
    const split: AnthropicMessagesAssistantTurn = [{ role: 'assistant', content: [{ type: 'text', text: 'hel', citations: null }, { type: 'text', text: 'lo', citations: [] }] }];
    const merged: AnthropicMessagesAssistantTurn = [{ role: 'assistant', content: [{ type: 'text', text: 'hello' }] }];
    expect(await verifyAnthropicMessagesReplayCheck(merged, await computeAnthropicMessagesReplayCheck(split))).toBe(true);
    expect(await verifyAnthropicMessagesReplayCheck(split, await computeAnthropicMessagesReplayCheck(merged))).toBe(true);
    const separate: AnthropicMessagesAssistantTurn = [{ role: 'assistant', content: 'hel' }, { role: 'assistant', content: 'lo' }];
    expect(await verifyAnthropicMessagesReplayCheck(merged, await computeAnthropicMessagesReplayCheck(separate))).toBe(false);
  });

  it('merges Messages text across citations, cache metadata and tool blocks', async () => {
    const citation = { type: 'char_location' as const, cited_text: 'source', document_index: 0, document_title: null, start_char_index: 0, end_char_index: 6 };
    const cited: AnthropicMessagesAssistantTurn = [{ role: 'assistant', content: [{ type: 'text', text: 'hel', citations: [citation] }, { type: 'text', text: 'lo' }] }];
    const merged: AnthropicMessagesAssistantTurn = [{ role: 'assistant', content: [{ type: 'text', text: 'hello', citations: [citation] }] }];
    expect(await verifyAnthropicMessagesReplayCheck(merged, await computeAnthropicMessagesReplayCheck(cited))).toBe(true);
    const cached: AnthropicMessagesAssistantTurn = [{ role: 'assistant', content: [{ type: 'text', text: 'hel', cache_control: { type: 'ephemeral' } }, { type: 'text', text: 'lo' }] }];
    expect(await verifyAnthropicMessagesReplayCheck([{ role: 'assistant', content: 'hello' }], await computeAnthropicMessagesReplayCheck(cached))).toBe(true);
    const tool = { type: 'tool_use' as const, id: 'call', name: 'lookup', input: {} };
    const interrupted: AnthropicMessagesAssistantTurn = [{ role: 'assistant', content: [{ type: 'text', text: 'hel' }, tool, { type: 'text', text: 'lo' }] }];
    expect(await verifyAnthropicMessagesReplayCheck([{ role: 'assistant', content: [{ type: 'text', text: 'hello' }, tool] }], await computeAnthropicMessagesReplayCheck(interrupted))).toBe(true);
  });

  it('keeps Messages nontext channels inside their owning message', async () => {
    const thinking = { type: 'thinking' as const, thinking: 'thought', signature: 'signature' };
    const tool = { type: 'tool_use' as const, id: 'call', name: 'lookup', input: {} };
    const original: AnthropicMessagesAssistantTurn = [
      { role: 'assistant', content: [{ type: 'text', text: 'A' }, thinking, tool] },
      { role: 'assistant', content: [{ type: 'text', text: 'B' }] },
    ];
    const check = await computeAnthropicMessagesReplayCheck(original);
    expect(await verifyAnthropicMessagesReplayCheck([
      { role: 'assistant', content: [{ type: 'text', text: 'A' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'B' }, thinking, tool] },
    ], check)).toBe(false);
  });

  it('merges Responses text by channel while retaining item boundaries', async () => {
    const split: OpenAIResponsesAssistantTurn = [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'hel', annotations: [], logprobs: [] }, { type: 'output_text', text: 'lo', annotations: [] }] }];
    const merged: OpenAIResponsesAssistantTurn = [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'hello' }] }];
    expect(await verifyOpenAIResponsesReplayCheck(merged, await computeOpenAIResponsesReplayCheck(split))).toBe(true);
    expect(await verifyOpenAIResponsesReplayCheck(split, await computeOpenAIResponsesReplayCheck(merged))).toBe(true);
    const interrupted: OpenAIResponsesAssistantTurn = [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hel' }, { type: 'refusal', refusal: 'no' }, { type: 'output_text', text: 'lo' }] }];
    expect(await verifyOpenAIResponsesReplayCheck([{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello' }, { type: 'refusal', refusal: 'no' }] }], await computeOpenAIResponsesReplayCheck(interrupted))).toBe(true);
    expect(await verifyOpenAIResponsesReplayCheck([{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hellono' }] }], await computeOpenAIResponsesReplayCheck(interrupted))).toBe(false);
    const separate: OpenAIResponsesAssistantTurn = [{ type: 'message', role: 'assistant', status: 'completed', content: 'hel' }, { type: 'message', role: 'assistant', status: 'completed', content: 'lo' }];
    expect(await verifyOpenAIResponsesReplayCheck(merged, await computeOpenAIResponsesReplayCheck(separate))).toBe(false);
  });

  it('ignores Responses annotations and logprobs when comparing text channels', async () => {
    const annotation = { type: 'url_citation' as const, start_index: 0, end_index: 3, title: 'source', url: 'https://example.test' };
    const logprob = { token: 'hel', logprob: -0.1, bytes: [104, 101, 108], top_logprobs: [] };
    for (const metadata of [{ annotations: [annotation] }, { logprobs: [logprob] }]) {
      const split: OpenAIResponsesAssistantTurn = [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hel', ...metadata }, { type: 'output_text', text: 'lo' }] }];
      expect(await verifyOpenAIResponsesReplayCheck([{ type: 'message', role: 'assistant', content: 'hello' }], await computeOpenAIResponsesReplayCheck(split))).toBe(true);
    }
  });

  it('merges reasoning parts only within the same Responses item and channel', async () => {
    const split: OpenAIResponsesAssistantTurn = [{ type: 'reasoning', summary: [{ type: 'summary_text', text: 'hel' }, { type: 'summary_text', text: 'lo' }], content: [{ type: 'reasoning_text', text: 'think' }, { type: 'reasoning_text', text: 'ing' }] }];
    const merged: OpenAIResponsesAssistantTurn = [{ type: 'reasoning', summary: [{ type: 'summary_text', text: 'hello' }], content: [{ type: 'reasoning_text', text: 'thinking' }] }];
    expect(await verifyOpenAIResponsesReplayCheck(merged, await computeOpenAIResponsesReplayCheck(split))).toBe(true);
    expect(await verifyOpenAIResponsesReplayCheck(split, await computeOpenAIResponsesReplayCheck(merged))).toBe(true);
    expect(await verifyOpenAIResponsesReplayCheck([{ type: 'reasoning', summary: [{ type: 'summary_text', text: 'hellothinking' }] }], await computeOpenAIResponsesReplayCheck(split))).toBe(false);
    expect(await verifyOpenAIResponsesReplayCheck([{ type: 'reasoning', summary: [{ type: 'summary_text', text: 'hel' }] }, { type: 'reasoning', summary: [{ type: 'summary_text', text: 'lo' }] }], await computeOpenAIResponsesReplayCheck([{ type: 'reasoning', summary: [{ type: 'summary_text', text: 'hello' }] }]))).toBe(false);
  });

  it('merges visible Gemini text across ignored metadata and nontext parts within one Content', async () => {
    const merged: GeminiGenerateContentAssistantTurn = [{ role: 'model', parts: [{ text: 'hello' }] }];
    const split: GeminiGenerateContentAssistantTurn = [{ role: 'model', parts: [{ text: 'hel' }, { text: 'lo' }] }];
    expect(await verifyGeminiGenerateContentReplayCheck(merged, await computeGeminiGenerateContentReplayCheck(split))).toBe(true);
    expect(await verifyGeminiGenerateContentReplayCheck(split, await computeGeminiGenerateContentReplayCheck(merged))).toBe(true);
    for (const metadata of [{ thought: false }, { thoughtSignature: 'native-signature' }]) {
      expect(await verifyGeminiGenerateContentReplayCheck(merged, await computeGeminiGenerateContentReplayCheck([{ role: 'model', parts: [{ text: 'hel', ...metadata }, { text: 'lo' }] }]))).toBe(true);
    }
    expect(await verifyGeminiGenerateContentReplayCheck(merged, await computeGeminiGenerateContentReplayCheck([{ role: 'model', parts: [{ text: 'hel' }] }, { role: 'model', parts: [{ text: 'lo' }] }]))).toBe(false);
    const image = { inlineData: { mimeType: 'image/png', data: 'AQID' } };
    expect(await verifyGeminiGenerateContentReplayCheck([{ role: 'model', parts: [{ text: 'hello' }, image] }], await computeGeminiGenerateContentReplayCheck([{ role: 'model', parts: [{ text: 'hel' }, image, { text: 'lo' }] }]))).toBe(true);
  });

  it('keeps Gemini nontext channels inside their owning Content', async () => {
    const call = { functionCall: { name: 'lookup', args: { q: 'x' } } };
    const image = { inlineData: { mimeType: 'image/png', data: 'AQID' } };
    const original: GeminiGenerateContentAssistantTurn = [
      { role: 'model', parts: [{ text: 'A' }, call, image] },
      { role: 'model', parts: [{ text: 'B' }] },
    ];
    const check = await computeGeminiGenerateContentReplayCheck(original);
    expect(await verifyGeminiGenerateContentReplayCheck([
      { role: 'model', parts: [{ text: 'A' }] },
      { role: 'model', parts: [{ text: 'B' }, call, image] },
    ], check)).toBe(false);
  });

  it('uses UTF-16 concatenation even when a part boundary splits a surrogate pair', async () => {
    const first = 'prefix \ud83d';
    const second = '\ude00 suffix';
    expect(await verifyGeminiGenerateContentReplayCheck([{ parts: [{ text: first + second }] }], await computeGeminiGenerateContentReplayCheck([{ parts: [{ text: first }, { text: second }] }]))).toBe(true);
  });
});
