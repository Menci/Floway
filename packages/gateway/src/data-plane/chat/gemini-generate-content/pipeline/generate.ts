import { attachGeminiGenerateContentAffinity } from './attach-affinity.ts';
import { geminiGenerateContentBody, servesGeminiGenerateContent } from './body.ts';
import { encodeGeminiGenerateContent } from './encode-response.ts';
import { normalizeGeminiGenerateContentErrorStatus } from './normalize-error-status.ts';
import { geminiGenerateContentAffinityUnavailable, geminiGenerateContentModelUnavailable, parseGeminiGenerateContent } from './parse-request.ts';
import { geminiGenerateContentActionEntry } from './route-action.ts';
import { discoverCandidates } from '../../../pipeline/discover-candidates.ts';
import { gatewayFactSpace } from '../../../pipeline/facts.ts';
import { failover } from '../../../pipeline/failover.ts';
import { requestBody } from '../../../pipeline/request-body.ts';
import type { GatewayServices } from '../../../pipeline/services.ts';
import { stripFlowayAuth } from '../../../pipeline/strip-floway-auth.ts';
import { normalizeDamagedUpstreamResponse } from '../../../shared/normalize-damaged-upstream-response.ts';
import { prepareChatAffinity } from '../../pipeline/affinity.ts';
import { enterChatBody } from '../../pipeline/topology.ts';
import { analyzeGeminiGenerateContentAffinity } from '../affinity/ingress.ts';

const protocol = 'geminiGenerateContent';
const responseKey = 'response.geminiGenerateContent';
const { compose } = gatewayFactSpace<GatewayServices>();

export const geminiGenerateContentGeneratePipeline = compose('geminiGenerateContent.generate', {
  entry: geminiGenerateContentActionEntry,
  exit: ['response.http'],
  stages: [
    requestBody,
    stripFlowayAuth,
    parseGeminiGenerateContent('generate'),
    encodeGeminiGenerateContent,
    normalizeDamagedUpstreamResponse(responseKey),
    normalizeGeminiGenerateContentErrorStatus,
    discoverCandidates('chat'),
    failover(responseKey, geminiGenerateContentModelUnavailable('generate'), servesGeminiGenerateContent,
      prepareChatAffinity(protocol, analyzeGeminiGenerateContentAffinity, geminiGenerateContentAffinityUnavailable)),
    attachGeminiGenerateContentAffinity,
  ],
  ...enterChatBody(protocol, geminiGenerateContentBody),
});
