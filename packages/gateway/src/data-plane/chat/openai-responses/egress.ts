import { applyAliasRules } from './stages/apply-alias-rules.ts';
import { applyRoleCompatibility } from './stages/apply-role-compatibility.ts';
import { normalizeExclusiveCachedTokens } from './stages/normalize-exclusive-cached-tokens.ts';
import { priceCall, recordCall } from '../../pipeline/call-metering.ts';
import type { GatewayServices } from '../../pipeline/services.ts';
import { openaiResponsesProviderTargets } from '../../providers/upstreams.ts';
import { createChatProviderEnding } from '../shared/enter-upstream.ts';
import { observeOpenAIResponsesCall } from '../shared/observe-usage.ts';
import type { ChatEgressInput, ChatEgressOutput } from '../shared/route-body.ts';
import { compose } from '@floway-dev/pipeline';

type Api = 'openaiResponses';
type Space = ChatEgressInput<Api> & ChatEgressOutput<Api>;
const entry = ['request.http', 'request.auth.apiKeyId', 'request.auth.user', 'request.route.upstreamIds',
  'request.route.randomizeUpstreams', 'request.route.runtimeLocation', 'request.action', 'request.payload', 'route.candidate', 'route.targetApi'] as const;
const exit = ['response.http', 'response.modelKey', 'response.openaiResponses'] as const;

export const openaiResponsesEgress = compose<Space, GatewayServices>()('openai-responses.egress', {
  entry,
  exit,
  stages: [recordCall('chat'), priceCall, observeOpenAIResponsesCall, applyRoleCompatibility, normalizeExclusiveCachedTokens, applyAliasRules],
  ending: createChatProviderEnding('openaiResponses', openaiResponsesProviderTargets),
  targets: openaiResponsesProviderTargets,
});
