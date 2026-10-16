import { describe, expect, it, vi } from 'vitest';

import { createTestSidecarCodec } from './sidecar-codec.ts';
import { computeOpenAIChatCompletionsReplayCheck, createOpenAIChatCompletionsSidecarCarrier, inspectOpenAIChatCompletionsAssistantTurn, verifyOpenAIChatCompletionsReplayCheck } from '../../src/protocols/openai-chat-completions/as-source/round-trip.ts';
import { roundTripAssistantTurn } from '../../src/round-trip/replay.ts';
import type { OpenAIChatCompletionsAssistantMessageEx } from '@floway-dev/protocols/openai-chat-completions';

describe('assistant-turn replay boundary', () => {
  it('returns no restored turn when the source has no sidecar', async () => {
    await expect(roundTripAssistantTurn(
      'openaiChatCompletions',
      'anthropicMessages',
      { role: 'assistant', content: 'answer' },
      createTestSidecarCodec(),
      inspectOpenAIChatCompletionsAssistantTurn,
      verifyOpenAIChatCompletionsReplayCheck,
    )).resolves.toBeUndefined();
  });

  it('restores the recognized target assistant turn', async () => {
    const codec = createTestSidecarCodec();
    const sourceTurn: OpenAIChatCompletionsAssistantMessageEx = {
      role: 'assistant',
      content: 'answer',
    };
    const assistantTurn = {
      role: 'assistant' as const,
      content: [{ type: 'text' as const, text: 'native target answer', citations: null }],
    };
    const data = await codec.encode({
      source: 'openaiChatCompletions',
      target: 'anthropicMessages',
      assistantTurn,
      replayCheck: await computeOpenAIChatCompletionsReplayCheck(sourceTurn),
    });
    sourceTurn.reasoning_details = createOpenAIChatCompletionsSidecarCarrier(data);
    const verify = vi.fn(verifyOpenAIChatCompletionsReplayCheck);

    await expect(roundTripAssistantTurn(
      'openaiChatCompletions',
      'anthropicMessages',
      sourceTurn,
      codec,
      inspectOpenAIChatCompletionsAssistantTurn,
      verify,
    )).resolves.toEqual({ turn: assistantTurn });
    expect(verify).toHaveBeenCalledExactlyOnceWith({ role: 'assistant', content: 'answer', reasoning_details: [] }, expect.any(Object));
  });

  it('restores the terminal owned sidecar while preserving an earlier foreign carrier', async () => {
    const codec = createTestSidecarCodec();
    const foreign = 'native opaque state';
    const earlier = createOpenAIChatCompletionsSidecarCarrier(foreign);
    const source: OpenAIChatCompletionsAssistantMessageEx = { role: 'assistant', content: 'answer', reasoning_details: earlier };
    const assistantTurn = { role: 'assistant' as const, content: 'native target answer' };
    const data = await codec.encode({
      source: 'openaiChatCompletions',
      target: 'openaiChatCompletions', assistantTurn,
      replayCheck: await computeOpenAIChatCompletionsReplayCheck(source),
    });
    const turn = { ...source, reasoning_details: [...earlier, ...createOpenAIChatCompletionsSidecarCarrier(data)] };
    const verify = vi.fn(verifyOpenAIChatCompletionsReplayCheck);
    await expect(roundTripAssistantTurn('openaiChatCompletions', 'openaiChatCompletions', turn, codec, inspectOpenAIChatCompletionsAssistantTurn, verify)).resolves.toEqual({ turn: assistantTurn });
    expect(verify).toHaveBeenCalledExactlyOnceWith(source, expect.any(Object));
    expect(turn.reasoning_details[0].data).toBe(foreign);
  });

  it('does not search backward past a terminal foreign candidate', async () => {
    const codec = createTestSidecarCodec();
    const source: OpenAIChatCompletionsAssistantMessageEx = { role: 'assistant', content: 'answer' };
    const data = await codec.encode({
      source: 'openaiChatCompletions',
      target: 'openaiChatCompletions', assistantTurn: source,
      replayCheck: await computeOpenAIChatCompletionsReplayCheck(source),
    });
    const foreign = 'unrecognized terminal sidecar';
    const turn = { ...source, reasoning_details: [...createOpenAIChatCompletionsSidecarCarrier(data), ...createOpenAIChatCompletionsSidecarCarrier(foreign)] };
    const verify = vi.fn(verifyOpenAIChatCompletionsReplayCheck);
    await expect(roundTripAssistantTurn('openaiChatCompletions', 'openaiChatCompletions', turn, codec, inspectOpenAIChatCompletionsAssistantTurn, verify)).resolves.toBeUndefined();
    expect(verify).not.toHaveBeenCalled();
  });
});
