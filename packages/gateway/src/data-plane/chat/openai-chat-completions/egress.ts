import { applyAliasRules } from './stages/apply-alias-rules.ts';
import { applyRoleCompatibility } from './stages/apply-role-compatibility.ts';
import { normalizeExclusiveCachedTokens } from './stages/normalize-exclusive-cached-tokens.ts';
import { normalizeDeepSeekResponse } from './stages/vendor-deepseek-response.ts';
import { normalizeKimiResponse } from './stages/vendor-kimi-response.ts';
import type { GatewayServices } from '../../pipeline/services.ts';
import { createProviderTarget } from '../shared/enter-upstream.ts';
import { observeOpenAIChatCompletionsUsage } from '../shared/observe-usage.ts';
import type { ChatEgressInput, ChatEgressOutput } from '../shared/route-body.ts';
import { compose } from '@floway-dev/pipeline';
import type { OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import type { ProviderStreamOutput } from '@floway-dev/provider';

type Api = 'openaiChatCompletions';
const api: Api = 'openaiChatCompletions';
const provider = createProviderTarget<Api, ProviderStreamOutput<OpenAIChatCompletionsStreamEvent>>(
  api, api, pipelines => pipelines.openaiChatCompletions, ['response.http', 'response.modelKey', 'response.events'],
);

export const openaiChatCompletionsEgress = compose<ChatEgressInput<Api>, ChatEgressOutput<Api>, GatewayServices, typeof provider.targets>(
  'openaiChatCompletions.egress', {
    ...provider,
    stages: [observeOpenAIChatCompletionsUsage, applyRoleCompatibility, normalizeExclusiveCachedTokens, normalizeDeepSeekResponse, normalizeKimiResponse, applyAliasRules],
  },
);
