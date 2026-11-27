import type { AttemptTarget, GatewayRequestFacts, GatewayResponseFacts } from '../../pipeline/facts.ts';
import type { GatewayServices } from '../../pipeline/services.ts';
import { factSpace } from '@floway-dev/pipeline';

type CountTokensRequestFacts = GatewayRequestFacts & {
  anthropicMessagesCountTokensTargets: readonly AttemptTarget<'anthropicMessagesCountTokens'>[];
  geminiGenerateContentCountTokensTargets: readonly AttemptTarget<'geminiGenerateContentCountTokens'>[];
};

export const { defineStage, compose } = factSpace<CountTokensRequestFacts, GatewayResponseFacts, GatewayServices>();
