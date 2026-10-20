import { expect, test, vi } from 'vitest';

import { createTestSidecarCodec } from './sidecar-codec.ts';
import { computeAnthropicMessagesTurnDigest, findAnthropicMessagesSidecarCarriers, verifyAnthropicMessagesTurnDigest, type AnthropicMessagesAssistantTurn } from '../../src/protocols/anthropic-messages/as-source/round-trip.ts';
import { computeGeminiGenerateContentTurnDigest, findGeminiGenerateContentSidecarCarriers, verifyGeminiGenerateContentTurnDigest, type GeminiGenerateContentAssistantTurn } from '../../src/protocols/gemini-generate-content/as-source/round-trip.ts';
import { computeOpenAIChatCompletionsTurnDigest, findOpenAIChatCompletionsSidecarCarriers, verifyOpenAIChatCompletionsTurnDigest, type OpenAIChatCompletionsAssistantTurn } from '../../src/protocols/openai-chat-completions/as-source/round-trip.ts';
import { computeOpenAIResponsesTurnDigest, findOpenAIResponsesSidecarCarriers, verifyOpenAIResponsesTurnDigest, type OpenAIResponsesAssistantTurn } from '../../src/protocols/openai-responses/as-source/round-trip.ts';
import { roundTripAssistantTurn, type EncodedRoundTripSidecar } from '../../src/round-trip/resolve.ts';
import { encodeRoundTripSidecar, type RoundTripProtocol } from '../../src/round-trip/sidecar.ts';
import type { RoundTripTurnDigest } from '../../src/round-trip/turn-digest.ts';

const sourceCase = <Turn>(
  source: RoundTripProtocol,
  makeTurn: (carriers: string[]) => Turn,
  inspect: (turn: Turn) => EncodedRoundTripSidecar<Turn>[],
  compute: (turn: Turn) => Promise<RoundTripTurnDigest>,
  verify: (turn: Turn, check: RoundTripTurnDigest, version: number) => Promise<boolean>,
) => ({
  source,
  run: async (scenario: 'middle' | 'foreign' | 'wrong-direction' | 'duplicate' | 'different-targets' | 'malformed') => {
    const codec = createTestSidecarCodec();
    const ordinary = makeTurn(['foreign-before', 'foreign-after']);
    const check = await compute(ordinary);
    const restored = { role: 'assistant' as const, content: 'native target answer' };
    const owned = await encodeRoundTripSidecar(codec, { v: 1, source, target: 'openaiChatCompletions', targetTurn: restored, sourceTurnDigest: check });
    const checked = vi.fn(verify);
    const run = (turn: Turn) => roundTripAssistantTurn(source, 'openaiChatCompletions', turn, codec, inspect, checked, () => []);
    if (scenario === 'foreign') {
      const before = structuredClone(ordinary);
      await expect(run(ordinary)).resolves.toBeUndefined();
      expect(checked).not.toHaveBeenCalled();
      expect(ordinary).toEqual(before);
    } else if (scenario === 'middle') {
      const turn = makeTurn(['foreign-before', owned, 'foreign-after']);
      const before = structuredClone(turn);
      await expect(run(turn)).resolves.toEqual({ turn: restored });
      expect(checked).toHaveBeenCalledExactlyOnceWith(ordinary, check, 1);
      expect(turn).toEqual(before);
    } else if (scenario === 'wrong-direction') {
      const wrongSource = source === 'anthropicMessages' ? 'openaiResponses' : 'anthropicMessages';
      const foreign = await encodeRoundTripSidecar(codec, { v: 1, source: wrongSource, target: 'openaiChatCompletions', targetTurn: restored, sourceTurnDigest: check });
      const history = makeTurn([foreign]);
      const own = await encodeRoundTripSidecar(codec, { v: 1, source, target: 'openaiChatCompletions', targetTurn: restored, sourceTurnDigest: await compute(history) });
      await expect(run(makeTurn([own, foreign]))).resolves.toEqual({ turn: restored });
      expect(checked).toHaveBeenCalledExactlyOnceWith(history, expect.any(Object), 1);
    } else if (scenario === 'malformed') {
      // Deliberately bypass the typed encoder to exercise authenticated envelope validation.
      const broken = await codec.encode({ v: 1, source, target: 'anthropicMessages', targetTurn: { role: 'user' }, sourceTurnDigest: check });
      await expect(run(makeTurn([owned, broken]))).rejects.toThrow('Messages assistant turn is invalid');
      expect(checked).not.toHaveBeenCalled();
    } else {
      const second = scenario === 'duplicate' ? owned : await encodeRoundTripSidecar(codec, {
        v: 1, source, target: 'anthropicMessages', targetTurn: { role: 'assistant', content: [] }, sourceTurnDigest: check,
      });
      await expect(run(makeTurn([second, owned]))).rejects.toThrow('multiple recognized round-trip sidecars');
      expect(checked).not.toHaveBeenCalled();
    }
  },
});

const cases = [
  sourceCase('openaiChatCompletions', (carriers): OpenAIChatCompletionsAssistantTurn => ({
    role: 'assistant', content: 'answer', reasoning_details: [
      ...carriers.map(data => ({ type: 'reasoning.encrypted', data })), { type: 'reasoning.summary', summary: 'ordinary summary' },
    ],
  }), findOpenAIChatCompletionsSidecarCarriers, computeOpenAIChatCompletionsTurnDigest, verifyOpenAIChatCompletionsTurnDigest),
  sourceCase('anthropicMessages', (carriers): AnthropicMessagesAssistantTurn => [{
    role: 'assistant', content: [{ type: 'text', text: 'answer' }, ...carriers.map(data => ({ type: 'redacted_thinking' as const, data })), { type: 'text', text: 'tail' }],
  }, { role: 'assistant', content: '' }, { role: 'assistant', content: [] }], findAnthropicMessagesSidecarCarriers, computeAnthropicMessagesTurnDigest, verifyAnthropicMessagesTurnDigest),
  sourceCase('openaiResponses', (carriers): OpenAIResponsesAssistantTurn => [
    { type: 'message', role: 'assistant', content: 'answer' }, ...carriers.map(encrypted_content => ({ type: 'reasoning' as const, summary: [], encrypted_content })),
    { type: 'message', role: 'assistant', content: [] },
  ], findOpenAIResponsesSidecarCarriers, computeOpenAIResponsesTurnDigest, verifyOpenAIResponsesTurnDigest),
  sourceCase('geminiGenerateContent', (carriers): GeminiGenerateContentAssistantTurn => [{
    role: 'model', parts: [{ text: 'answer' }, ...carriers.map(thoughtSignature => ({ thoughtSignature })), { text: 'tail' }],
  }, { role: 'model' }, { role: 'model', parts: [] }], findGeminiGenerateContentSidecarCarriers, computeGeminiGenerateContentTurnDigest, verifyGeminiGenerateContentTurnDigest),
];

const scenarios = ['middle', 'foreign', 'wrong-direction', 'duplicate', 'different-targets', 'malformed'] as const;

test.each(cases.flatMap(source => scenarios.map(scenario => ({ ...source, scenario }))))('$source selects by ownership: $scenario', async ({ run, scenario }) => {
  await run(scenario);
});
