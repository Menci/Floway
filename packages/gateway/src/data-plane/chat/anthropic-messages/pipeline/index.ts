import { attachAnthropicMessagesAffinity } from './attach-affinity.ts';
import { anthropicMessagesBody, servesAnthropicMessages } from './body.ts';
import { encodeAnthropicMessages } from './encode-response.ts';
import { anthropicMessagesAffinityUnavailable, anthropicMessagesModelUnavailable, parseAnthropicMessages } from './parse-request.ts';
import { serializeStreamItems } from './serialize-stream-items.ts';
import { discoverCandidates } from '../../../pipeline/discover-candidates.ts';
import { gatewayFactSpace, httpEntry } from '../../../pipeline/facts.ts';
import { failover } from '../../../pipeline/failover.ts';
import { requestBody } from '../../../pipeline/request-body.ts';
import type { GatewayServices } from '../../../pipeline/services.ts';
import { stripFlowayAuth } from '../../../pipeline/strip-floway-auth.ts';
import { normalizeDamagedUpstreamResponse } from '../../../shared/normalize-damaged-upstream-response.ts';
import { prepareChatAffinity } from '../../pipeline/affinity.ts';
import { enterChatBody } from '../../pipeline/topology.ts';
import { analyzeAnthropicMessagesAffinity } from '../affinity/ingress.ts';

const protocol = 'anthropicMessages';
const responseKey = 'response.anthropicMessages';
const { compose } = gatewayFactSpace<GatewayServices>();

export const anthropicMessagesPipeline = compose('anthropicMessages.ingress', {
  entry: httpEntry,
  exit: ['response.http'],
  stages: [
    requestBody,
    stripFlowayAuth,
    parseAnthropicMessages('generate'),
    encodeAnthropicMessages,
    normalizeDamagedUpstreamResponse(responseKey),
    discoverCandidates('chat'),
    failover(responseKey, anthropicMessagesModelUnavailable('generate'), servesAnthropicMessages,
      prepareChatAffinity(protocol, analyzeAnthropicMessagesAffinity, anthropicMessagesAffinityUnavailable)),
    attachAnthropicMessagesAffinity,
    serializeStreamItems,
  ],
  ...enterChatBody(protocol, anthropicMessagesBody),
});
