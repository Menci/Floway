import type { CodexPipelineConfig, CodexRequest } from './pipeline-facts.ts';
import { authenticateCodex } from './stages/authenticate.ts';
import { authorizeCodexHeaders } from './stages/authorize-headers.ts';
import { observeCodexResponse } from './stages/observe-response.ts';
import { prepareCodexRequest } from './stages/prepare-request.ts';
import { readCodexAccount } from './stages/read-account.ts';
import { retryCodexAccess } from './stages/retry-access.ts';
import { http } from '@floway-dev/http/pipeline';
import { compose } from '@floway-dev/pipeline';
import type { ProviderPipelines, ProviderResponse } from '@floway-dev/provider';

export const createCodexPipelines = (config: CodexPipelineConfig): ProviderPipelines => ({
  alphaSearch: compose<CodexRequest<'alphaSearch'>, ProviderResponse>('codex.alphaSearch', [readCodexAccount<'alphaSearch'>(config), authenticateCodex(config, 'alphaSearch'), prepareCodexRequest('alphaSearch'), retryCodexAccess(config, 'alphaSearch'), authorizeCodexHeaders, observeCodexResponse(config, 'alphaSearch'), http]),
  openaiImagesGenerations: compose<CodexRequest<'openaiImagesGenerations'>, ProviderResponse>('codex.openaiImagesGenerations', [readCodexAccount<'openaiImagesGenerations'>(config), authenticateCodex(config, 'openaiImagesGenerations'), prepareCodexRequest('openaiImagesGenerations'), retryCodexAccess(config, 'openaiImagesGenerations'), authorizeCodexHeaders, observeCodexResponse(config, 'openaiImagesGenerations'), http]),
  openaiImagesEdits: compose<CodexRequest<'openaiImagesEdits'>, ProviderResponse>('codex.openaiImagesEdits', [readCodexAccount<'openaiImagesEdits'>(config), authenticateCodex(config, 'openaiImagesEdits'), prepareCodexRequest('openaiImagesEdits'), retryCodexAccess(config, 'openaiImagesEdits'), authorizeCodexHeaders, observeCodexResponse(config, 'openaiImagesEdits'), http]),
});
