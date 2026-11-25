import type { ClaudeCodeServices } from '../../service.ts';
import { factSpace } from '@floway-dev/pipeline';
import type { ProviderOperationFacts, ProviderTransportFacts } from '@floway-dev/provider';

type Facts = ProviderOperationFacts<'anthropicMessages'> & ProviderTransportFacts & {
  readonly 'request.claudeCodeShaped': boolean;
};

export const { defineStage, compose } = factSpace<Facts, ClaudeCodeServices>();
