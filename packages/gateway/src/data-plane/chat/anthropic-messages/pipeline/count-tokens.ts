import { applyAliasRules } from './apply-alias-rules.ts';
import { applyRoleCompatibility } from './apply-role-compatibility.ts';
import { disableReasoningOnForcedToolChoice } from './disable-reasoning-on-forced-tool-choice.ts';
import { encodeAnthropicMessagesCountTokens } from './encode-response.ts';
import { normalizeEmptyToolsToolChoice } from './normalize-empty-tools-tool-choice.ts';
import { anthropicMessagesAffinityUnavailable, anthropicMessagesModelUnavailable, parseAnthropicMessages } from './parse-request.ts';
import { stripBillingAttribution } from './strip-billing-attribution.ts';
import { anthropicMessagesWebSearch } from './web-search-shim.ts';
import { computeUsage } from '../../../pipeline/compute-usage.ts';
import { discoverCandidates } from '../../../pipeline/discover-candidates.ts';
import { enterProvider } from '../../../pipeline/enter-provider.ts';
import { gatewayFactSpace, httpEntry } from '../../../pipeline/facts.ts';
import { failover } from '../../../pipeline/failover.ts';
import { recordPerformance } from '../../../pipeline/performance.ts';
import { providerSupportsOperation } from '../../../pipeline/provider-pipelines.ts';
import { requestBody } from '../../../pipeline/request-body.ts';
import type { GatewayServices } from '../../../pipeline/services.ts';
import { storeUsage } from '../../../pipeline/store-usage.ts';
import { stripFlowayAuth } from '../../../pipeline/strip-floway-auth.ts';
import { normalizeDamagedUpstreamResponse } from '../../../shared/normalize-damaged-upstream-response.ts';
import { prepareChatAffinity } from '../../pipeline/affinity.ts';
import { analyzeAnthropicMessagesAffinity } from '../affinity/ingress.ts';

const protocol = 'anthropicMessages';
const responseKey = 'response.anthropicMessages';
const operation = 'anthropicMessagesCountTokens';
const { compose } = gatewayFactSpace<GatewayServices>();

export const anthropicMessagesCountTokensPipeline = compose('anthropicMessagesCountTokens.ingress', {
  entry: httpEntry,
  exit: ['response.http'],
  stages: [
    requestBody,
    stripFlowayAuth,
    parseAnthropicMessages('countTokens'),
    encodeAnthropicMessagesCountTokens,
    normalizeDamagedUpstreamResponse(responseKey),
    discoverCandidates('chat'),
    failover(responseKey, anthropicMessagesModelUnavailable('countTokens'),
      ({ model, upstream }) => model.endpoints.anthropicMessages !== undefined && providerSupportsOperation(upstream.kind, operation),
      prepareChatAffinity(protocol, analyzeAnthropicMessagesAffinity, anthropicMessagesAffinityUnavailable)),
    anthropicMessagesWebSearch(operation),
    stripBillingAttribution,
    disableReasoningOnForcedToolChoice,
    normalizeEmptyToolsToolChoice,
    applyRoleCompatibility(operation),
    storeUsage,
    recordPerformance(responseKey, { operation: 'chat', providerOperation: operation }),
    computeUsage(responseKey, { kind: 'unbillable' }),
    applyAliasRules,
  ],
  ...enterProvider(operation),
});
