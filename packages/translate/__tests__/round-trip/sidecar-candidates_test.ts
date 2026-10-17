import { expect, test, vi } from 'vitest';

import { createTestSidecarCodec } from './sidecar-codec.ts';
import { computeAnthropicMessagesReplayCheck, inspectAnthropicMessagesAssistantTurn, verifyAnthropicMessagesReplayCheck, type AnthropicMessagesAssistantTurn } from '../../src/protocols/anthropic-messages/as-source/round-trip.ts';
import { computeGeminiGenerateContentReplayCheck, inspectGeminiGenerateContentAssistantTurn, verifyGeminiGenerateContentReplayCheck, type GeminiGenerateContentAssistantTurn } from '../../src/protocols/gemini-generate-content/as-source/round-trip.ts';
import { computeOpenAIChatCompletionsReplayCheck, inspectOpenAIChatCompletionsAssistantTurn, verifyOpenAIChatCompletionsReplayCheck, type OpenAIChatCompletionsAssistantTurn } from '../../src/protocols/openai-chat-completions/as-source/round-trip.ts';
import { computeOpenAIResponsesReplayCheck, inspectOpenAIResponsesAssistantTurn, verifyOpenAIResponsesReplayCheck, type OpenAIResponsesAssistantTurn } from '../../src/protocols/openai-responses/as-source/round-trip.ts';
import type { RoundTripReplayCheck } from '../../src/round-trip/replay-check.ts';
import { roundTripAssistantTurn, type RoundTripSidecarCandidate } from '../../src/round-trip/replay.ts';
import type { RoundTripProtocol } from '../../src/round-trip/sidecar.ts';

const sourceCase = <Turn>(
  source: RoundTripProtocol,
  makeTurn: (carriers: string[]) => Turn,
  inspect: (turn: Turn) => RoundTripSidecarCandidate<Turn>[],
  compute: (turn: Turn) => Promise<RoundTripReplayCheck>,
  verify: (turn: Turn, check: RoundTripReplayCheck) => Promise<boolean>,
) => ({
  source,
  run: async (scenario: 'middle' | 'foreign' | 'wrong-direction' | 'duplicate' | 'different-targets' | 'malformed') => {
    const codec = createTestSidecarCodec();
    const ordinary = makeTurn(['foreign-before', 'foreign-after']);
    const check = await compute(ordinary);
    const restored = { role: 'assistant' as const, content: 'native target answer' };
    const owned = await codec.encode({ source, target: 'openaiChatCompletions', assistantTurn: restored, replayCheck: check });
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
      expect(checked).toHaveBeenCalledExactlyOnceWith(ordinary, check);
      expect(turn).toEqual(before);
    } else if (scenario === 'wrong-direction') {
      const wrongSource = source === 'anthropicMessages' ? 'openaiResponses' : 'anthropicMessages';
      const foreign = await codec.encode({ source: wrongSource, target: 'openaiChatCompletions', assistantTurn: restored, replayCheck: check });
      const history = makeTurn([foreign]);
      const own = await codec.encode({ source, target: 'openaiChatCompletions', assistantTurn: restored, replayCheck: await compute(history) });
      await expect(run(makeTurn([own, foreign]))).resolves.toEqual({ turn: restored });
      expect(checked).toHaveBeenCalledExactlyOnceWith(history, expect.any(Object));
    } else if (scenario === 'malformed') {
      const broken = await codec.encode({ source, target: 'anthropicMessages', assistantTurn: { role: 'user' }, replayCheck: check });
      await expect(run(makeTurn([owned, broken]))).rejects.toThrow('Messages assistant turn is invalid');
      expect(checked).not.toHaveBeenCalled();
    } else {
      const second = scenario === 'duplicate' ? owned : await codec.encode({
        source, target: 'anthropicMessages', assistantTurn: { role: 'assistant', content: [] }, replayCheck: check,
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
  }), inspectOpenAIChatCompletionsAssistantTurn, computeOpenAIChatCompletionsReplayCheck, verifyOpenAIChatCompletionsReplayCheck),
  sourceCase('anthropicMessages', (carriers): AnthropicMessagesAssistantTurn => [{
    role: 'assistant', content: [{ type: 'text', text: 'answer' }, ...carriers.map(data => ({ type: 'redacted_thinking' as const, data })), { type: 'text', text: 'tail' }],
  }, { role: 'assistant', content: '' }, { role: 'assistant', content: [] }], inspectAnthropicMessagesAssistantTurn, computeAnthropicMessagesReplayCheck, verifyAnthropicMessagesReplayCheck),
  sourceCase('openaiResponses', (carriers): OpenAIResponsesAssistantTurn => [
    { type: 'message', role: 'assistant', content: 'answer' }, ...carriers.map(encrypted_content => ({ type: 'reasoning' as const, summary: [], encrypted_content })),
    { type: 'message', role: 'assistant', content: [] },
  ], inspectOpenAIResponsesAssistantTurn, computeOpenAIResponsesReplayCheck, verifyOpenAIResponsesReplayCheck),
  sourceCase('geminiGenerateContent', (carriers): GeminiGenerateContentAssistantTurn => [{
    role: 'model', parts: [{ text: 'answer' }, ...carriers.map(thoughtSignature => ({ thoughtSignature })), { text: 'tail' }],
  }, { role: 'model' }, { role: 'model', parts: [] }], inspectGeminiGenerateContentAssistantTurn, computeGeminiGenerateContentReplayCheck, verifyGeminiGenerateContentReplayCheck),
];

const scenarios = ['middle', 'foreign', 'wrong-direction', 'duplicate', 'different-targets', 'malformed'] as const;

test.each(cases.flatMap(source => scenarios.map(scenario => ({ ...source, scenario }))))('$source selects by ownership: $scenario', async ({ run, scenario }) => {
  await run(scenario);
});
