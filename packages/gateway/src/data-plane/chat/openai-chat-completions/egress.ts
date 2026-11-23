import { applyAliasRules } from './stages/apply-alias-rules.ts';
import { applyRoleCompatibility } from './stages/apply-role-compatibility.ts';
import { normalizeExclusiveCachedTokens } from './stages/normalize-exclusive-cached-tokens.ts';
import { normalizeDeepSeekResponse } from './stages/vendor-deepseek-response.ts';
import { normalizeKimiResponse } from './stages/vendor-kimi-response.ts';
import { priceCall, recordCall } from '../../pipeline/call-metering.ts';
import type { GatewayServices } from '../../pipeline/services.ts';
import { openaiChatCompletionsProviderTargets } from '../../providers/upstreams.ts';
import { createChatProviderEnding } from '../shared/enter-upstream.ts';
import { observeOpenAIChatCompletionsCall } from '../shared/observe-usage.ts';
import type { ChatEgressInput, ChatEgressOutput } from '../shared/route-body.ts';
import { compose } from '@floway-dev/pipeline';

type Api = 'openaiChatCompletions';
type Space = ChatEgressInput<Api> & ChatEgressOutput<Api>;

export const openaiChatCompletionsEgress = compose<Space, GatewayServices>()('openaiChatCompletions.egress', {
  entry: [
    'request.http', 'request.auth.apiKeyId', 'request.auth.user', 'request.route.upstreamIds', 'request.route.randomizeUpstreams',
    'request.route.runtimeLocation', 'route.candidate', 'route.targetApi', 'request.payload',
  ],
  exit: ['response.http', 'response.modelKey', 'response.openaiChatCompletions'],
  stages: [
    recordCall('chat'), priceCall, observeOpenAIChatCompletionsCall, applyRoleCompatibility, normalizeExclusiveCachedTokens,
    normalizeDeepSeekResponse, normalizeKimiResponse, applyAliasRules,
  ],
  ending: createChatProviderEnding('openaiChatCompletions', openaiChatCompletionsProviderTargets),
  targets: openaiChatCompletionsProviderTargets,
});
