import { encodeGeminiGenerateContentCountTokens } from './encode-response.ts';
import { servesNativeGeminiGenerateContent } from './native-target.ts';
import { normalizeGeminiGenerateContentErrorStatus } from './normalize-error-status.ts';
import { geminiGenerateContentAffinityUnavailable, geminiGenerateContentModelUnavailable, parseGeminiGenerateContent } from './parse-request.ts';
import { geminiGenerateContentActionEntry } from './route-action.ts';
import { computeUsage } from '../../../pipeline/compute-usage.ts';
import { discoverCandidates } from '../../../pipeline/discover-candidates.ts';
import { enterProvider } from '../../../pipeline/enter-provider.ts';
import { gatewayFactSpace } from '../../../pipeline/facts.ts';
import { failover } from '../../../pipeline/failover.ts';
import { recordPerformance } from '../../../pipeline/performance.ts';
import { requestBody } from '../../../pipeline/request-body.ts';
import type { GatewayServices } from '../../../pipeline/services.ts';
import { storeUsage } from '../../../pipeline/store-usage.ts';
import { stripFlowayAuth } from '../../../pipeline/strip-floway-auth.ts';
import { normalizeDamagedUpstreamResponse } from '../../../shared/normalize-damaged-upstream-response.ts';
import { prepareChatAffinity } from '../../pipeline/affinity.ts';
import type { AffinityCodec, AffinityRequestAnalysis } from '../../shared/affinity/index.ts';
import { analyzeGeminiGenerateContentAffinity } from '../affinity/ingress.ts';
import type { GeminiGenerateContentCountTokensPayload } from '@floway-dev/protocols/gemini-generate-content';

const protocol = 'geminiGenerateContent';
const responseKey = 'response.geminiGenerateContent';
const operation = 'geminiGenerateContentCountTokens';
const { compose } = gatewayFactSpace<GatewayServices>();

const analyzeAffinity = async (
  payload: GeminiGenerateContentCountTokensPayload,
  codec: AffinityCodec,
): Promise<AffinityRequestAnalysis<GeminiGenerateContentCountTokensPayload>> => {
  const { generateContentRequest } = payload;
  if (generateContentRequest === undefined) throw new TypeError('Expected a prepared Gemini countTokens request');
  const affinity = await analyzeGeminiGenerateContentAffinity(generateContentRequest, codec);
  return {
    requiredTargets: affinity.requiredTargets,
    evaluateCandidate: candidate => {
      const evaluation = affinity.evaluateCandidate(candidate);
      if (evaluation.kind === 'rejected') return evaluation;
      return {
        ...evaluation,
        materialize: () => ({ generateContentRequest: { ...evaluation.materialize(), model: generateContentRequest.model } }),
      };
    },
  };
};

export const geminiGenerateContentCountTokensPipeline = compose('geminiGenerateContentCountTokens.ingress', {
  entry: geminiGenerateContentActionEntry,
  exit: ['response.http'],
  stages: [
    requestBody,
    stripFlowayAuth,
    parseGeminiGenerateContent('countTokens'),
    encodeGeminiGenerateContentCountTokens,
    normalizeDamagedUpstreamResponse(responseKey),
    normalizeGeminiGenerateContentErrorStatus,
    discoverCandidates('chat'),
    failover(responseKey, geminiGenerateContentModelUnavailable('countTokens'), candidate => servesNativeGeminiGenerateContent(candidate, operation),
      prepareChatAffinity(protocol, analyzeAffinity, geminiGenerateContentAffinityUnavailable)),
    storeUsage,
    recordPerformance(responseKey, { operation: 'chat', providerOperation: operation }),
    computeUsage(responseKey, { kind: 'unbillable' }),
  ],
  ...enterProvider(operation),
});
