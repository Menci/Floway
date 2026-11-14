import type { ChatGPTPipelineConfig, ChatGPTRequest } from './pipeline-facts.ts';
import { authenticateChatGPT } from './stages/authenticate.ts';
import { authorizeChatGPTHeaders } from './stages/authorize-headers.ts';
import { observeChatGPTResponse } from './stages/observe-response.ts';
import { prepareChatGPTRequest } from './stages/prepare-request.ts';
import { readChatGPTAccount } from './stages/read-account.ts';
import { retryChatGPTAccess } from './stages/retry-access.ts';
import { http } from '@floway-dev/http/pipeline';
import { compose } from '@floway-dev/pipeline';
import type { ProviderPipelines, ProviderResponse } from '@floway-dev/provider';

export const createChatGPTPipelines = (config: ChatGPTPipelineConfig): ProviderPipelines => ({
  alphaSearch: compose<ChatGPTRequest<'alphaSearch'>, ProviderResponse>('chatgpt.alphaSearch', [readChatGPTAccount<'alphaSearch'>(config), authenticateChatGPT(config, 'alphaSearch'), prepareChatGPTRequest('alphaSearch'), retryChatGPTAccess(config, 'alphaSearch'), authorizeChatGPTHeaders, observeChatGPTResponse(config, 'alphaSearch'), http]),
  openaiImagesGenerations: compose<ChatGPTRequest<'openaiImagesGenerations'>, ProviderResponse>('chatgpt.openaiImagesGenerations', [readChatGPTAccount<'openaiImagesGenerations'>(config), authenticateChatGPT(config, 'openaiImagesGenerations'), prepareChatGPTRequest('openaiImagesGenerations'), retryChatGPTAccess(config, 'openaiImagesGenerations'), authorizeChatGPTHeaders, observeChatGPTResponse(config, 'openaiImagesGenerations'), http]),
  openaiImagesEdits: compose<ChatGPTRequest<'openaiImagesEdits'>, ProviderResponse>('chatgpt.openaiImagesEdits', [readChatGPTAccount<'openaiImagesEdits'>(config), authenticateChatGPT(config, 'openaiImagesEdits'), prepareChatGPTRequest('openaiImagesEdits'), retryChatGPTAccess(config, 'openaiImagesEdits'), authorizeChatGPTHeaders, observeChatGPTResponse(config, 'openaiImagesEdits'), http]),
});
