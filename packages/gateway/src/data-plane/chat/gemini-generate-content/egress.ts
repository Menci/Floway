import { applyAliasRules } from './stages/apply-alias-rules.ts';
import { priceCall, recordCall } from '../../pipeline/call-metering.ts';
import type { GatewayServices } from '../../pipeline/services.ts';
import { geminiGenerateContentCountTokensProviderTargets, geminiGenerateContentProviderTargets } from '../../providers/upstreams.ts';
import { createChatProviderEnding } from '../shared/enter-upstream.ts';
import { observeGeminiGenerateContentCall } from '../shared/observe-usage.ts';
import type { ChatEgressInput, ChatEgressOutput } from '../shared/route-body.ts';
import { compose } from '@floway-dev/pipeline';
import type { ProviderGeminiCountTokensOutput } from '@floway-dev/provider';

type Api = 'geminiGenerateContent';
const countEntry = ['request.http', 'request.payload', 'route.candidate'] as const;
const entry = [...countEntry, 'route.targetApi', 'request.auth.apiKeyId', 'request.route.runtimeLocation'] as const;
const exit = ['response.http', 'response.modelKey', 'response.geminiGenerateContent'] as const;
const countExit = ['response.http', 'response.modelKey', 'response.geminiGenerateContentCountTokens'] as const;

export const geminiGenerateContentEgress = compose<ChatEgressInput<Api> & ChatEgressOutput<Api>, GatewayServices>()(
  'geminiGenerateContent.egress', {
    entry, exit,
    stages: [recordCall('chat'), priceCall, observeGeminiGenerateContentCall, applyAliasRules],
    ending: createChatProviderEnding('geminiGenerateContent', geminiGenerateContentProviderTargets),
    targets: geminiGenerateContentProviderTargets,
  },
);

export const geminiGenerateContentCountEgress = compose<ChatEgressInput<Api> & ProviderGeminiCountTokensOutput, GatewayServices>()(
  'geminiGenerateContentCountTokens.egress', {
    entry: countEntry, exit: countExit, stages: [],
    ending: createChatProviderEnding('geminiGenerateContentCountTokens', geminiGenerateContentCountTokensProviderTargets),
    targets: geminiGenerateContentCountTokensProviderTargets,
  },
);
