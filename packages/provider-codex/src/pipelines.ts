import type { CodexPipelineConfig, CodexRequest } from './pipeline-facts.ts';
import { authenticateCodex } from './stages/authenticate.ts';
import { authorizeCodexHeaders } from './stages/authorize-headers.ts';
import { injectCodexDefaultInstructions } from './stages/inject-default-instructions.ts';
import { normalizeCodexResponsesHeaders } from './stages/normalize-responses-headers.ts';
import { observeCodexResponse } from './stages/observe-response.ts';
import { prepareCodexRequest } from './stages/prepare-request.ts';
import { prepareCodexResponses } from './stages/prepare-responses.ts';
import { readCodexAccount } from './stages/read-account.ts';
import { restoreCodexResponsesLite } from './stages/restore-responses-lite.ts';
import { restoreCodexResponsesOutput } from './stages/restore-responses-output.ts';
import { retryCodexAccess } from './stages/retry-access.ts';
import { stripCodexUnsupportedFields } from './stages/strip-unsupported-response-fields.ts';
import { http } from '@floway-dev/http/pipeline';
import { compose } from '@floway-dev/pipeline';
import { decodeProviderResponse, observeProviderCall, selectProviderResponsesAction, type ProviderChatResponse, type ProviderPipelines, type ProviderResponse } from '@floway-dev/provider';

export const createCodexPipelines = (config: CodexPipelineConfig): ProviderPipelines => ({
  openaiResponses: compose<CodexRequest<'openaiResponses'>, ProviderChatResponse<'openaiResponses'>>('codex.openaiResponses', [selectProviderResponsesAction('generate'), readCodexAccount<'openaiResponses'>(config), authenticateCodex(config, 'openaiResponses'), injectCodexDefaultInstructions, stripCodexUnsupportedFields, prepareCodexResponses(config, 'openaiResponses'), restoreCodexResponsesOutput, restoreCodexResponsesLite, decodeProviderResponse('openaiResponses'), retryCodexAccess(config, 'openaiResponses'), authorizeCodexHeaders, normalizeCodexResponsesHeaders, observeCodexResponse(config, 'openaiResponses'), observeProviderCall, http]),
  openaiResponsesCompact: compose<CodexRequest<'openaiResponsesCompact'>, ProviderChatResponse<'openaiResponsesCompact'>>('codex.openaiResponsesCompact', [selectProviderResponsesAction('compact'), readCodexAccount<'openaiResponsesCompact'>(config), authenticateCodex(config, 'openaiResponsesCompact'), injectCodexDefaultInstructions, stripCodexUnsupportedFields, prepareCodexResponses(config, 'openaiResponsesCompact'), restoreCodexResponsesLite, decodeProviderResponse('openaiResponsesCompact'), retryCodexAccess(config, 'openaiResponsesCompact'), authorizeCodexHeaders, observeCodexResponse(config, 'openaiResponsesCompact'), observeProviderCall, http]),
  alphaSearch: compose<CodexRequest<'alphaSearch'>, ProviderResponse>('codex.alphaSearch', [readCodexAccount<'alphaSearch'>(config), authenticateCodex(config, 'alphaSearch'), prepareCodexRequest('alphaSearch'), retryCodexAccess(config, 'alphaSearch'), authorizeCodexHeaders, observeCodexResponse(config, 'alphaSearch'), observeProviderCall, http]),
  openaiImagesGenerations: compose<CodexRequest<'openaiImagesGenerations'>, ProviderResponse>('codex.openaiImagesGenerations', [readCodexAccount<'openaiImagesGenerations'>(config), authenticateCodex(config, 'openaiImagesGenerations'), prepareCodexRequest('openaiImagesGenerations'), retryCodexAccess(config, 'openaiImagesGenerations'), authorizeCodexHeaders, observeCodexResponse(config, 'openaiImagesGenerations'), observeProviderCall, http]),
  openaiImagesEdits: compose<CodexRequest<'openaiImagesEdits'>, ProviderResponse>('codex.openaiImagesEdits', [readCodexAccount<'openaiImagesEdits'>(config), authenticateCodex(config, 'openaiImagesEdits'), prepareCodexRequest('openaiImagesEdits'), retryCodexAccess(config, 'openaiImagesEdits'), authorizeCodexHeaders, observeCodexResponse(config, 'openaiImagesEdits'), observeProviderCall, http]),
});
