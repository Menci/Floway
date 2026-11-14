import type { ChatGPTPipelineConfig, ChatGPTRequest } from './pipeline-facts.ts';
import { authenticateChatGPT } from './stages/authenticate.ts';
import { authorizeChatGPTHeaders } from './stages/authorize-headers.ts';
import { injectChatGPTDefaultInstructions } from './stages/inject-default-instructions.ts';
import { normalizeChatGPTResponsesHeaders } from './stages/normalize-responses-headers.ts';
import { observeChatGPTResponse } from './stages/observe-response.ts';
import { prepareChatGPTRequest } from './stages/prepare-request.ts';
import { prepareChatGPTResponsesPayload } from './stages/prepare-responses-content.ts';
import { prepareChatGPTResponsesHttp } from './stages/prepare-responses.ts';
import { projectChatGPTMovedResponsesFields } from './stages/project-moved-responses-fields.ts';
import { readChatGPTAccount } from './stages/read-account.ts';
import { restoreChatGPTResponsesOutput } from './stages/restore-responses-output.ts';
import { retryChatGPTAccess } from './stages/retry-access.ts';
import { stripChatGPTUnsupportedFields } from './stages/strip-unsupported-response-fields.ts';
import { http } from '@floway-dev/http/pipeline';
import { compose } from '@floway-dev/pipeline';
import { decodeProviderResponse, observeProviderCall, observeProviderResponsesCall, selectProviderResponsesAction, type ProviderChatResponse, type ProviderPipelines, type ProviderResponse } from '@floway-dev/provider';

export const createChatGPTPipelines = (config: ChatGPTPipelineConfig): ProviderPipelines => ({
  openaiResponses: compose<ChatGPTRequest<'openaiResponses'>, ProviderChatResponse<'openaiResponses'>>('chatgpt.openaiResponses', [selectProviderResponsesAction('generate'), readChatGPTAccount<'openaiResponses'>(config), injectChatGPTDefaultInstructions, stripChatGPTUnsupportedFields, prepareChatGPTResponsesPayload<'openaiResponses'>(), authenticateChatGPT(config, 'openaiResponses'), prepareChatGPTResponsesHttp<'openaiResponses'>(), restoreChatGPTResponsesOutput, projectChatGPTMovedResponsesFields, decodeProviderResponse('openaiResponses'), retryChatGPTAccess(config, 'openaiResponses'), authorizeChatGPTHeaders, normalizeChatGPTResponsesHeaders, observeChatGPTResponse(config, 'openaiResponses'), observeProviderResponsesCall, http]),
  openaiResponsesCompact: compose<ChatGPTRequest<'openaiResponsesCompact'>, ProviderChatResponse<'openaiResponsesCompact'>>('chatgpt.openaiResponsesCompact', [selectProviderResponsesAction('compact'), readChatGPTAccount<'openaiResponsesCompact'>(config), injectChatGPTDefaultInstructions, stripChatGPTUnsupportedFields, prepareChatGPTResponsesPayload<'openaiResponsesCompact'>(), authenticateChatGPT(config, 'openaiResponsesCompact'), prepareChatGPTResponsesHttp<'openaiResponsesCompact'>(), decodeProviderResponse('openaiResponsesCompact'), retryChatGPTAccess(config, 'openaiResponsesCompact'), authorizeChatGPTHeaders, observeChatGPTResponse(config, 'openaiResponsesCompact'), observeProviderResponsesCall, http]),
  alphaSearch: compose<ChatGPTRequest<'alphaSearch'>, ProviderResponse>('chatgpt.alphaSearch', [readChatGPTAccount<'alphaSearch'>(config), authenticateChatGPT(config, 'alphaSearch'), prepareChatGPTRequest('alphaSearch'), retryChatGPTAccess(config, 'alphaSearch'), authorizeChatGPTHeaders, observeChatGPTResponse(config, 'alphaSearch'), observeProviderCall, http]),
  openaiImagesGenerations: compose<ChatGPTRequest<'openaiImagesGenerations'>, ProviderResponse>('chatgpt.openaiImagesGenerations', [readChatGPTAccount<'openaiImagesGenerations'>(config), authenticateChatGPT(config, 'openaiImagesGenerations'), prepareChatGPTRequest('openaiImagesGenerations'), retryChatGPTAccess(config, 'openaiImagesGenerations'), authorizeChatGPTHeaders, observeChatGPTResponse(config, 'openaiImagesGenerations'), observeProviderCall, http]),
  openaiImagesEdits: compose<ChatGPTRequest<'openaiImagesEdits'>, ProviderResponse>('chatgpt.openaiImagesEdits', [readChatGPTAccount<'openaiImagesEdits'>(config), authenticateChatGPT(config, 'openaiImagesEdits'), prepareChatGPTRequest('openaiImagesEdits'), retryChatGPTAccess(config, 'openaiImagesEdits'), authorizeChatGPTHeaders, observeChatGPTResponse(config, 'openaiImagesEdits'), observeProviderCall, http]),
});
