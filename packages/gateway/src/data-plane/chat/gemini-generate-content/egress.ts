import { applyAliasRules } from './stages/apply-alias-rules.ts';
import type { GatewayServices } from '../../pipeline/services.ts';
import { createProviderTarget } from '../shared/enter-upstream.ts';
import { observeGeminiGenerateContentUsage } from '../shared/observe-usage.ts';
import type { ChatEgressInput, ChatEgressOutput } from '../shared/route-body.ts';
import { compose } from '@floway-dev/pipeline';
import type { GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';
import type { ProviderHttpOutput, ProviderStreamOutput } from '@floway-dev/provider';

type Api = 'geminiGenerateContent';
const api: Api = 'geminiGenerateContent';
const generate = createProviderTarget<Api, ProviderStreamOutput<GeminiGenerateContentStreamEvent>>(
  api, api, pipelines => pipelines.geminiGenerateContent, ['response.http', 'response.modelKey', 'response.events'],
);

export const geminiGenerateContentEgress = compose<ChatEgressInput<Api>, ChatEgressOutput<Api>, GatewayServices, typeof generate.targets>(
  'geminiGenerateContent.egress', { ...generate, stages: [observeGeminiGenerateContentUsage, applyAliasRules] },
);

export interface GeminiCountEgressOutput extends ProviderHttpOutput {
  readonly 'response.targetApi': Api;
  readonly 'response.source': 'upstream';
}

const count = createProviderTarget<Api, ProviderHttpOutput>(
  api, 'geminiGenerateContentCountTokens', pipelines => pipelines.geminiGenerateContentCountTokens, ['response.http', 'response.modelKey'],
);

export const geminiGenerateContentCountEgress = compose<ChatEgressInput<Api>, GeminiCountEgressOutput, GatewayServices, typeof count.targets>(
  'geminiGenerateContentCountTokens.egress', { ...count, stages: [] },
);
