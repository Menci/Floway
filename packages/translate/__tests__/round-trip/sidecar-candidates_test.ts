import { expect, test, vi } from 'vitest';

import { createTestSidecarCodec } from './sidecar-codec.ts';
import { collectAnthropicMessagesCallIds, computeAnthropicMessagesTurnDigest, findAnthropicMessagesSidecarOccurrences, verifyAnthropicMessagesTurnDigest, type AnthropicMessagesSourceAssistantTurn } from '../../src/protocols/anthropic-messages/as-source/round-trip.ts';
import { collectGeminiGenerateContentCallIds, computeGeminiGenerateContentTurnDigest, findGeminiGenerateContentSidecarOccurrences, verifyGeminiGenerateContentTurnDigest, type GeminiGenerateContentSourceAssistantTurn } from '../../src/protocols/gemini-generate-content/as-source/round-trip.ts';
import { collectOpenAIChatCompletionsCallIds, computeOpenAIChatCompletionsTurnDigest, findOpenAIChatCompletionsSidecarOccurrences, verifyOpenAIChatCompletionsTurnDigest, type OpenAIChatCompletionsSourceAssistantTurn } from '../../src/protocols/openai-chat-completions/as-source/round-trip.ts';
import { collectOpenAIResponsesCallIds, computeOpenAIResponsesTurnDigest, findOpenAIResponsesSidecarOccurrences, verifyOpenAIResponsesTurnDigest, type OpenAIResponsesSourceAssistantTurn } from '../../src/protocols/openai-responses/as-source/round-trip.ts';
import { type AssistantTurnProtocol } from '../../src/round-trip/input-assistant-turn.ts';
import { roundTripAssistantTurn, type SidecarOccurrence } from '../../src/round-trip/resolve.ts';
import { ROUND_TRIP_SIDECAR_VERSION, encodeRoundTripSidecar } from '../../src/round-trip/sidecar.ts';
import type { RoundTripTurnDigest } from '../../src/round-trip/turn-digest.ts';

const sourceCase = <Turn>(
  source: AssistantTurnProtocol,
  makeTurn: (carriers: string[]) => Turn,
  inspect: (turn: Turn) => SidecarOccurrence<Turn>[],
  compute: (turn: Turn) => Promise<RoundTripTurnDigest>,
  verify: (turn: Turn, check: RoundTripTurnDigest, version: number) => Promise<boolean>,
  collectCallIds: (turn: Turn) => readonly (string | undefined)[],
) => ({
  source,
  run: async (scenario: 'middle' | 'foreign' | 'wrong-direction' | 'duplicate' | 'different-targets' | 'malformed') => {
    const codec = createTestSidecarCodec();
    const ordinary = makeTurn(['foreign-before', 'foreign-after']);
    const check = await compute(ordinary);
    const restored = { role: 'assistant' as const, content: 'native target answer' };
    const owned = await encodeRoundTripSidecar(codec, { v: ROUND_TRIP_SIDECAR_VERSION, source, target: 'openaiChatCompletions', targetTurn: restored, sourceTurnDigest: check });
    const checked = vi.fn(verify);
    const run = (turn: Turn) => roundTripAssistantTurn(source, 'openaiChatCompletions', turn, codec, { inspect, verify: checked, collectCandidates: () => [], collectCallIds });
    if (scenario === 'foreign') {
      const before = structuredClone(ordinary);
      await expect(run(ordinary)).resolves.toBeUndefined();
      expect(checked).not.toHaveBeenCalled();
      expect(ordinary).toEqual(before);
    } else if (scenario === 'middle') {
      const turn = makeTurn(['foreign-before', owned, 'foreign-after']);
      const before = structuredClone(turn);
      await expect(run(turn)).resolves.toEqual({ turn: restored, sourceCallIds: [] });
      expect(checked).toHaveBeenCalledExactlyOnceWith(ordinary, check, ROUND_TRIP_SIDECAR_VERSION);
      expect(turn).toEqual(before);
    } else if (scenario === 'wrong-direction') {
      const wrongSource = source === 'anthropicMessages' ? 'openaiResponses' : 'anthropicMessages';
      const foreign = await encodeRoundTripSidecar(codec, { v: ROUND_TRIP_SIDECAR_VERSION, source: wrongSource, target: 'openaiChatCompletions', targetTurn: restored, sourceTurnDigest: check });
      const history = makeTurn([foreign]);
      const own = await encodeRoundTripSidecar(codec, { v: ROUND_TRIP_SIDECAR_VERSION, source, target: 'openaiChatCompletions', targetTurn: restored, sourceTurnDigest: await compute(history) });
      await expect(run(makeTurn([own, foreign]))).resolves.toEqual({ turn: restored, sourceCallIds: [] });
      expect(checked).toHaveBeenCalledExactlyOnceWith(history, expect.any(Object), ROUND_TRIP_SIDECAR_VERSION);
    } else if (scenario === 'malformed') {
      // Deliberately bypass the typed encoder to exercise authenticated envelope validation.
      const broken = await codec.encode({ v: ROUND_TRIP_SIDECAR_VERSION, source, target: 'anthropicMessages', targetTurn: { role: 'user' }, sourceTurnDigest: check });
      await expect(run(makeTurn([owned, broken]))).rejects.toThrow(TypeError);
      expect(checked).not.toHaveBeenCalled();
    } else {
      const second = scenario === 'duplicate' ? owned : await encodeRoundTripSidecar(codec, {
        v: ROUND_TRIP_SIDECAR_VERSION, source, target: 'anthropicMessages', targetTurn: { role: 'assistant', content: [] }, sourceTurnDigest: check,
      });
      await expect(run(makeTurn([second, owned]))).rejects.toThrow();
      expect(checked).not.toHaveBeenCalled();
    }
  },
});

const cases = [
  sourceCase('openaiChatCompletions', (carriers): OpenAIChatCompletionsSourceAssistantTurn => ({
    role: 'assistant', content: 'answer', reasoning_details: [
      ...carriers.map(data => ({ type: 'reasoning.encrypted', data })), { type: 'reasoning.summary', summary: 'ordinary summary' },
    ],
  }), findOpenAIChatCompletionsSidecarOccurrences, computeOpenAIChatCompletionsTurnDigest, verifyOpenAIChatCompletionsTurnDigest, collectOpenAIChatCompletionsCallIds),
  sourceCase('anthropicMessages', (carriers): AnthropicMessagesSourceAssistantTurn => [{
    role: 'assistant', content: [{ type: 'text', text: 'answer' }, ...carriers.map(data => ({ type: 'redacted_thinking' as const, data })), { type: 'text', text: 'tail' }],
  }, { role: 'assistant', content: '' }, { role: 'assistant', content: [] }], findAnthropicMessagesSidecarOccurrences, computeAnthropicMessagesTurnDigest, verifyAnthropicMessagesTurnDigest, collectAnthropicMessagesCallIds),
  sourceCase('openaiResponses', (carriers): OpenAIResponsesSourceAssistantTurn => [
    { type: 'message', role: 'assistant', content: 'answer' }, ...carriers.map(encrypted_content => ({ type: 'reasoning' as const, summary: [], encrypted_content })),
    { type: 'message', role: 'assistant', content: [] },
  ], findOpenAIResponsesSidecarOccurrences, computeOpenAIResponsesTurnDigest, verifyOpenAIResponsesTurnDigest, collectOpenAIResponsesCallIds),
  sourceCase('geminiGenerateContent', (carriers): GeminiGenerateContentSourceAssistantTurn => [{
    role: 'model', parts: [{ text: 'answer' }, ...carriers.map(thoughtSignature => ({ thoughtSignature })), { text: 'tail' }],
  }, { role: 'model' }, { role: 'model', parts: [] }], findGeminiGenerateContentSidecarOccurrences, computeGeminiGenerateContentTurnDigest, verifyGeminiGenerateContentTurnDigest, collectGeminiGenerateContentCallIds),
];

const scenarios = ['middle', 'foreign', 'wrong-direction', 'duplicate', 'different-targets', 'malformed'] as const;

// Selection by ownership is protocol-agnostic; every other protocol still runs
// the scenario that exercises its own carrier inspection and digest material.
test.each([
  ...scenarios.map(scenario => ({ ...cases[0], scenario })),
  ...cases.slice(1).map(source => ({ ...source, scenario: 'middle' as const })),
])('$source selects by ownership: $scenario', async ({ run, scenario }) => {
  await run(scenario);
});
