import type { KimiCodeServices } from '../service.ts';
import type { KimiCodeUpstream } from '../upstream.ts';
import { factSpace } from '@floway-dev/pipeline';
import type { ProviderOperationFacts } from '@floway-dev/provider';

type KimiCodeOperation = 'openaiChatCompletions' | 'openaiResponses' | 'anthropicMessages' | 'anthropicMessagesCountTokens';
export type KimiCodeFacts = ProviderOperationFacts<KimiCodeOperation, KimiCodeUpstream>;
export const { compose, defineStage } = factSpace<KimiCodeFacts, KimiCodeServices>();
