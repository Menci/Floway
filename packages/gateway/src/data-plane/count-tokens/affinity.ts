import { analyzeAnthropicMessagesAffinity } from '../chat/anthropic-messages/affinity/ingress.ts';
import { analyzeGeminiGenerateContentAffinity } from '../chat/gemini-generate-content/affinity/ingress.ts';
import { geminiGenerateContentRpcErrorPayload } from '../chat/gemini-generate-content/errors.ts';
import { buildAttemptTargets } from '../chat/shared/affinity/attempt-targets.ts';
import type { AffinityCodec } from '../chat/shared/affinity/carrier.ts';
import type { AffinityRequestAnalysis } from '../chat/shared/affinity/selection.ts';
import { localResponseHead } from '../pipeline/encode.ts';
import { generateAnthropicId } from '@floway-dev/protocols/anthropic-messages';
import type { GeminiCountTokensPayload } from '@floway-dev/protocols/gemini-generate-content';

const analyzeGeminiCountTokensAffinity = async (
  { generateContentRequest, contents }: GeminiCountTokensPayload,
  codec: AffinityCodec,
): Promise<AffinityRequestAnalysis<GeminiCountTokensPayload>> => {
  const analysis = await analyzeGeminiGenerateContentAffinity(generateContentRequest ?? { contents: contents ?? [] }, codec);
  return {
    ...analysis,
    evaluateCandidate(candidate) {
      const evaluated = analysis.evaluateCandidate(candidate);
      if (evaluated.kind === 'rejected') return evaluated;
      return {
        ...evaluated,
        materialize() {
          const value = evaluated.materialize();
          return generateContentRequest === undefined
            ? { contents: value.contents }
            : { generateContentRequest: { ...value, model: generateContentRequest.model } };
        },
      };
    },
  };
};

export const buildAnthropicMessagesCountTokensAttemptTargets = buildAttemptTargets(
  'anthropicMessagesCountTokens',
  analyzeAnthropicMessagesAffinity,
  message => ({
    http: { ...localResponseHead(400), body: null },
    outcome: {
      kind: 'error',
      source: 'local',
      error: { type: 'error', error: { type: 'invalid_request_error', message }, request_id: generateAnthropicId('req') },
    },
  }),
);

export const buildGeminiGenerateContentCountTokensAttemptTargets = buildAttemptTargets(
  'geminiGenerateContentCountTokens',
  analyzeGeminiCountTokensAffinity,
  message => ({
    http: { ...localResponseHead(400), body: null },
    outcome: { kind: 'error', source: 'local', error: geminiGenerateContentRpcErrorPayload(400, message) },
  }),
);
