import { accountFacts, type CodexAccountFacts, type CodexOperation, type CodexPipelineConfig, type CodexRequest } from '../pipeline-facts.ts';
import { defineStage, move, type Handed } from '@floway-dev/pipeline';
import type { ProviderResponse, ProviderServices } from '@floway-dev/provider';

export const readCodexAccount = <O extends CodexOperation>(config: CodexPipelineConfig) => defineStage<CodexRequest<O>, CodexAccountFacts<O>, ProviderResponse, ProviderResponse, ProviderServices>({
  name: 'readCodexAccount',
  through: {
    request: { needs: [], consumes: [], provides: ['request.codex.account'] },
    response: { needs: [], consumes: [], provides: [] },
  },
  execute: async (facts, next) => await next(move({ ...facts, 'request.codex.account': accountFacts(await config.readAccount()) })) as Handed<ProviderResponse>,
});
