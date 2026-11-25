import { attachOpenAIChatCompletionsAffinity } from './attach-affinity.ts';
import { openAIChatCompletionsBody, servesOpenAIChatCompletions } from './body.ts';
import { encodeOpenAIChatCompletions } from './encode-response.ts';
import { openAIChatCompletionsAffinityUnavailable, openAIChatCompletionsModelUnavailable, parseOpenAIChatCompletions } from './parse-request.ts';
import { discoverCandidates } from '../../../pipeline/discover-candidates.ts';
import { gatewayFactSpace, httpEntry } from '../../../pipeline/facts.ts';
import { failover } from '../../../pipeline/failover.ts';
import { requestBody } from '../../../pipeline/request-body.ts';
import type { GatewayServices } from '../../../pipeline/services.ts';
import { stripFlowayAuth } from '../../../pipeline/strip-floway-auth.ts';
import { normalizeDamagedUpstreamResponse } from '../../../shared/normalize-damaged-upstream-response.ts';
import { prepareChatAffinity } from '../../pipeline/affinity.ts';
import { enterChatBody } from '../../pipeline/topology.ts';
import { analyzeOpenAIChatCompletionsAffinity } from '../affinity/ingress.ts';

const { compose } = gatewayFactSpace<GatewayServices>();
const protocol = 'openaiChatCompletions';
const responseKey = 'response.openaiChatCompletions';

export const openAIChatCompletionsPipeline = compose('openaiChatCompletions.ingress', {
  entry: httpEntry,
  exit: ['response.http'],
  stages: [
    requestBody,
    stripFlowayAuth,
    parseOpenAIChatCompletions,
    encodeOpenAIChatCompletions,
    normalizeDamagedUpstreamResponse(responseKey),
    discoverCandidates('chat'),
    failover(responseKey, openAIChatCompletionsModelUnavailable, servesOpenAIChatCompletions,
      prepareChatAffinity(protocol, analyzeOpenAIChatCompletionsAffinity, openAIChatCompletionsAffinityUnavailable)),
    attachOpenAIChatCompletionsAffinity,
  ],
  ...enterChatBody(protocol, openAIChatCompletionsBody),
});
