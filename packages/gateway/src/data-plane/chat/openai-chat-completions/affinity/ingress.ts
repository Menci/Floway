import { decodeOpenAIChatCompletionsAffinity, evaluateOpenAIChatCompletionsAffinity } from './analysis.ts';
import type { AffinityCodec } from '../../shared/affinity/carrier.ts';
import { type AffinityRequestAnalysis, defineAffinityRequest } from '../../shared/affinity/selection.ts';
import type { OpenAIChatCompletionsPayloadEx } from '@floway-dev/protocols/openai-chat-completions';

export const analyzeOpenAIChatCompletionsAffinity = async (
  payload: OpenAIChatCompletionsPayloadEx, codec: AffinityCodec,
): Promise<AffinityRequestAnalysis<OpenAIChatCompletionsPayloadEx>> => {
  const analysis = await decodeOpenAIChatCompletionsAffinity(payload, codec);
  return defineAffinityRequest(analysis.requiredTargets, candidate => {
    const evaluation = evaluateOpenAIChatCompletionsAffinity(analysis, candidate, payload);
    return { ...evaluation, materialize: () => evaluation.payload };
  });
};
