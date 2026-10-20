import { describe, expect, it, vi } from 'vitest';

import { createTestSidecarCodec } from './sidecar-codec.ts';
import { computeOpenAIChatCompletionsTurnDigest, createOpenAIChatCompletionsSidecarCarrier, findOpenAIChatCompletionsSidecarCarriers, verifyOpenAIChatCompletionsTurnDigest } from '../../src/protocols/openai-chat-completions/as-source/round-trip.ts';
import { roundTripAssistantTurn } from '../../src/round-trip/resolve.ts';
import { encodeRoundTripSidecar } from '../../src/round-trip/sidecar.ts';
import type { OpenAIChatCompletionsAssistantMessageEx } from '@floway-dev/protocols/openai-chat-completions';

describe('assistant-turn replay boundary', () => {
  it('returns no restored turn when the source has no sidecar', async () => {
    await expect(roundTripAssistantTurn(
      'openaiChatCompletions',
      'anthropicMessages',
      { role: 'assistant', content: 'answer' },
      createTestSidecarCodec(),
      findOpenAIChatCompletionsSidecarCarriers,
      verifyOpenAIChatCompletionsTurnDigest,
      () => [],
    )).resolves.toBeUndefined();
  });

  it('restores the recognized target assistant turn', async () => {
    const codec = createTestSidecarCodec();
    const sourceTurn: OpenAIChatCompletionsAssistantMessageEx = {
      role: 'assistant',
      content: 'answer',
    };
    const targetTurn = {
      role: 'assistant' as const,
      content: [{ type: 'text' as const, text: 'native target answer', citations: null }],
    };
    const data = await encodeRoundTripSidecar(codec, {
      v: 1,
      source: 'openaiChatCompletions',
      target: 'anthropicMessages',
      targetTurn,
      sourceTurnDigest: await computeOpenAIChatCompletionsTurnDigest(sourceTurn),
    });
    sourceTurn.reasoning_details = createOpenAIChatCompletionsSidecarCarrier(data);
    const verify = vi.fn(verifyOpenAIChatCompletionsTurnDigest);

    await expect(roundTripAssistantTurn(
      'openaiChatCompletions',
      'anthropicMessages',
      sourceTurn,
      codec,
      findOpenAIChatCompletionsSidecarCarriers,
      verify,
      () => [],
    )).resolves.toEqual({ turn: targetTurn });
    expect(verify).toHaveBeenCalledExactlyOnceWith({ role: 'assistant', content: 'answer', reasoning_details: [] }, expect.any(Object), 1);
  });

  it('restores an owned sidecar while preserving an earlier foreign carrier', async () => {
    const codec = createTestSidecarCodec();
    const foreign = 'native opaque state';
    const earlier = createOpenAIChatCompletionsSidecarCarrier(foreign);
    const source: OpenAIChatCompletionsAssistantMessageEx = { role: 'assistant', content: 'answer', reasoning_details: earlier };
    const targetTurn = { role: 'assistant' as const, content: 'native target answer' };
    const data = await encodeRoundTripSidecar(codec, {
      v: 1,
      source: 'openaiChatCompletions',
      target: 'openaiChatCompletions', targetTurn,
      sourceTurnDigest: await computeOpenAIChatCompletionsTurnDigest(source),
    });
    const turn = { ...source, reasoning_details: [...earlier, ...createOpenAIChatCompletionsSidecarCarrier(data)] };
    const verify = vi.fn(verifyOpenAIChatCompletionsTurnDigest);
    await expect(roundTripAssistantTurn('openaiChatCompletions', 'openaiChatCompletions', turn, codec, findOpenAIChatCompletionsSidecarCarriers, verify, () => [])).resolves.toEqual({ turn: targetTurn });
    expect(verify).toHaveBeenCalledExactlyOnceWith(source, expect.any(Object), 1);
    expect(turn.reasoning_details[0].data).toBe(foreign);
  });

  it('restores an owned sidecar before a foreign candidate without stripping foreign state', async () => {
    const codec = createTestSidecarCodec();
    const foreign = 'unrecognized sidecar';
    const source: OpenAIChatCompletionsAssistantMessageEx = { role: 'assistant', content: 'answer', reasoning_details: createOpenAIChatCompletionsSidecarCarrier(foreign) };
    const data = await encodeRoundTripSidecar(codec, {
      v: 1,
      source: 'openaiChatCompletions',
      target: 'openaiChatCompletions', targetTurn: source,
      sourceTurnDigest: await computeOpenAIChatCompletionsTurnDigest(source),
    });
    const turn = { ...source, reasoning_details: [...createOpenAIChatCompletionsSidecarCarrier(data), ...createOpenAIChatCompletionsSidecarCarrier(foreign)] };
    const verify = vi.fn(verifyOpenAIChatCompletionsTurnDigest);
    await expect(roundTripAssistantTurn('openaiChatCompletions', 'openaiChatCompletions', turn, codec, findOpenAIChatCompletionsSidecarCarriers, verify, () => [])).resolves.toEqual({ turn: source });
    expect(verify).toHaveBeenCalledExactlyOnceWith(source, expect.any(Object), 1);
  });
});
