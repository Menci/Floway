import type { CopilotAuth } from './auth.ts';
import type { EmbeddingsRequest } from './pipeline-facts.ts';
import { copilotAnthropicMessagesApplyTopLevelCacheControl } from './stages/anthropic-messages/apply-top-level-cache-control.ts';
import { copilotAnthropicMessagesCompressImages } from './stages/anthropic-messages/compress-images.ts';
import { copilotAnthropicMessagesSpeedFast } from './stages/anthropic-messages/handle-speed-fast.ts';
import { copilotAnthropicMessagesNormalizeAnthropicBeta } from './stages/anthropic-messages/normalize-anthropic-beta.ts';
import { copilotAnthropicMessagesThinkingDisplay } from './stages/anthropic-messages/promote-thinking-display.ts';
import { rewriteCopilotContextWindowError } from './stages/anthropic-messages/rewrite-context-window-error.ts';
import { copilotAnthropicMessagesSetClaudeAgentHeaders } from './stages/anthropic-messages/set-claude-agent-headers.ts';
import { copilotAnthropicMessagesSetCompactHeaders } from './stages/anthropic-messages/set-compact-headers.ts';
import { copilotAnthropicMessagesSetInitiatorHeader } from './stages/anthropic-messages/set-initiator-header.ts';
import { copilotAnthropicMessagesSetInteractionIdHeader } from './stages/anthropic-messages/set-interaction-id-header.ts';
import { copilotAnthropicMessagesSetVisionHeader } from './stages/anthropic-messages/set-vision-header.ts';
import { copilotAnthropicMessagesStripCacheControlExtensions } from './stages/anthropic-messages/strip-cache-control-extensions.ts';
import { copilotAnthropicMessagesStripEagerInputStreaming } from './stages/anthropic-messages/strip-eager-input-streaming.ts';
import { authenticateCopilotChat } from './stages/authenticate-chat.ts';
import { authenticateCopilot } from './stages/authenticate.ts';
import { observeCopilotQuota } from './stages/observe-quota.ts';
import { copilotOpenAIChatCompletionsAbortToolWhitespace } from './stages/openai-chat-completions/abort-on-tool-argument-whitespace.ts';
import { copilotOpenAIChatCompletionsAttachCacheControlMarkers } from './stages/openai-chat-completions/attach-cache-control-markers.ts';
import { copilotOpenAIChatCompletionsCompressImages } from './stages/openai-chat-completions/compress-images.ts';
import { copilotOpenAIChatCompletionsSetInitiatorHeader } from './stages/openai-chat-completions/set-initiator-header.ts';
import { copilotOpenAIChatCompletionsSetVisionHeader } from './stages/openai-chat-completions/set-vision-header.ts';
import { copilotOpenAIResponsesAbortToolWhitespace } from './stages/openai-responses/abort-on-tool-argument-whitespace.ts';
import { copilotOpenAIResponsesCompressImages } from './stages/openai-responses/compress-images.ts';
import { copilotOpenAIResponsesFillEmptyNamespaceDescriptions } from './stages/openai-responses/fill-empty-namespace-descriptions.ts';
import { copilotOpenAIResponsesForceStoreFalse } from './stages/openai-responses/force-store-false.ts';
import { copilotOpenAIResponsesItemIdMembrane } from './stages/openai-responses/item-id-membrane.ts';
import { copilotOpenAIResponsesSetInitiatorHeader } from './stages/openai-responses/set-initiator-header.ts';
import { copilotOpenAIResponsesSetVisionHeader } from './stages/openai-responses/set-vision-header.ts';
import { copilotOpenAIResponsesStripImageGeneration } from './stages/openai-responses/strip-image-generation.ts';
import { copilotOpenAIResponsesStripServiceTier } from './stages/openai-responses/strip-service-tier.ts';
import { prepareCopilotChatRequest } from './stages/prepare-chat-request.ts';
import { prepareCopilotEmbeddings } from './stages/prepare-request.ts';
import { reshapeCopilotCompaction } from './stages/reshape-compaction.ts';
import { selectCopilotChatModel } from './stages/select-chat-model.ts';
import { http } from '@floway-dev/http/pipeline';
import { compose } from '@floway-dev/pipeline';
import { decodeProviderResponse, observeProviderCall, type ProviderOperationRequest, type ProviderOperationResponse, type ProviderPipelines, type ProviderResponse } from '@floway-dev/provider';

export const createCopilotPipelines = (auth: CopilotAuth): ProviderPipelines => ({
  openaiChatCompletions: compose<ProviderOperationRequest<'openaiChatCompletions'>, ProviderOperationResponse<'openaiChatCompletions'>>('copilot.openaiChatCompletions', [selectCopilotChatModel('openaiChatCompletions'), authenticateCopilotChat(auth), copilotOpenAIChatCompletionsCompressImages, copilotOpenAIChatCompletionsAbortToolWhitespace, copilotOpenAIChatCompletionsAttachCacheControlMarkers, copilotOpenAIChatCompletionsSetInitiatorHeader, copilotOpenAIChatCompletionsSetVisionHeader, decodeProviderResponse('openaiChatCompletions'), prepareCopilotChatRequest('openaiChatCompletions'), observeCopilotQuota(auth.id), observeProviderCall, http]),
  openaiResponses: compose<ProviderOperationRequest<'openaiResponses'>, ProviderOperationResponse<'openaiResponses'>>('copilot.openaiResponses', [selectCopilotChatModel('openaiResponses'), authenticateCopilotChat(auth), copilotOpenAIResponsesCompressImages, copilotOpenAIResponsesFillEmptyNamespaceDescriptions, copilotOpenAIResponsesStripServiceTier, copilotOpenAIResponsesStripImageGeneration, copilotOpenAIResponsesForceStoreFalse, copilotOpenAIResponsesItemIdMembrane, copilotOpenAIResponsesAbortToolWhitespace, copilotOpenAIResponsesSetVisionHeader, copilotOpenAIResponsesSetInitiatorHeader, decodeProviderResponse('openaiResponses'), prepareCopilotChatRequest('openaiResponses'), observeCopilotQuota(auth.id), observeProviderCall, http]),
  anthropicMessages: compose<ProviderOperationRequest<'anthropicMessages'>, ProviderOperationResponse<'anthropicMessages'>>('copilot.anthropicMessages', [selectCopilotChatModel('anthropicMessages'), authenticateCopilotChat(auth), rewriteCopilotContextWindowError, copilotAnthropicMessagesSetCompactHeaders, copilotAnthropicMessagesSetClaudeAgentHeaders, copilotAnthropicMessagesSetInteractionIdHeader, copilotAnthropicMessagesCompressImages, copilotAnthropicMessagesSpeedFast, copilotAnthropicMessagesThinkingDisplay, copilotAnthropicMessagesApplyTopLevelCacheControl, copilotAnthropicMessagesStripCacheControlExtensions, copilotAnthropicMessagesStripEagerInputStreaming, copilotAnthropicMessagesSetVisionHeader, copilotAnthropicMessagesSetInitiatorHeader, copilotAnthropicMessagesNormalizeAnthropicBeta, decodeProviderResponse('anthropicMessages'), prepareCopilotChatRequest('anthropicMessages'), observeCopilotQuota(auth.id), observeProviderCall, http]),
  anthropicMessagesCountTokens: compose<ProviderOperationRequest<'anthropicMessagesCountTokens'>, ProviderOperationResponse<'anthropicMessagesCountTokens'>>('copilot.anthropicMessagesCountTokens', [selectCopilotChatModel('anthropicMessagesCountTokens'), authenticateCopilotChat(auth), copilotAnthropicMessagesCompressImages, copilotAnthropicMessagesSetVisionHeader, copilotAnthropicMessagesSetInitiatorHeader, copilotAnthropicMessagesNormalizeAnthropicBeta, decodeProviderResponse('anthropicMessagesCountTokens'), prepareCopilotChatRequest('anthropicMessagesCountTokens'), observeCopilotQuota(auth.id), observeProviderCall, http]),
  openaiResponsesCompact: compose<ProviderOperationRequest<'openaiResponsesCompact'>, ProviderOperationResponse<'openaiResponsesCompact'>>('copilot.openaiResponsesCompact', [selectCopilotChatModel('openaiResponsesCompact'), authenticateCopilotChat(auth), copilotOpenAIResponsesCompressImages, copilotOpenAIResponsesFillEmptyNamespaceDescriptions, copilotOpenAIResponsesStripServiceTier, copilotOpenAIResponsesStripImageGeneration, copilotOpenAIResponsesForceStoreFalse, copilotOpenAIResponsesItemIdMembrane, copilotOpenAIResponsesAbortToolWhitespace, copilotOpenAIResponsesSetVisionHeader, copilotOpenAIResponsesSetInitiatorHeader, reshapeCopilotCompaction, decodeProviderResponse('openaiResponsesCompact'), prepareCopilotChatRequest('openaiResponsesCompact'), observeCopilotQuota(auth.id), observeProviderCall, http]),
  openaiEmbeddings: compose<EmbeddingsRequest, ProviderResponse>('copilot.openaiEmbeddings', [authenticateCopilot(auth), prepareCopilotEmbeddings(), observeCopilotQuota(auth.id), observeProviderCall, http]),
});
