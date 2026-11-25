import type { ClaudeCodeUpstream } from '../../config.ts';
import type { ClaudeCodeServices } from '../../service.ts';
import { factSpace } from '@floway-dev/pipeline';
import type { ProviderOperationFacts } from '@floway-dev/provider';

type ClaudeCodeFacts = ProviderOperationFacts<'anthropicMessages', ClaudeCodeUpstream> & {
  'request.claudeCodeShaped': boolean;
};

export const { defineStage, compose } = factSpace<ClaudeCodeFacts, ClaudeCodeServices>();
