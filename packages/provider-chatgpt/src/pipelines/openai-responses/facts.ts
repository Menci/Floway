import type { ChatGPTServices } from '../../service.ts';
import type { ChatGPTUpstreamFact } from '../../upstream-fact.ts';
import { factSpace } from '@floway-dev/pipeline';
import type { ProviderOperationFacts, ProviderTransportFacts } from '@floway-dev/provider';

export const { defineStage, compose } = factSpace<ProviderOperationFacts<'openaiResponses', ChatGPTUpstreamFact> & ProviderTransportFacts, ChatGPTServices>();
