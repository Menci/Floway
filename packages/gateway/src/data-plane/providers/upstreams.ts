import type { StoredUpstreamRecord } from '../../repo/types.ts';
import type { ProviderPipelines, UpstreamRecord } from '@floway-dev/provider';
import { azurePipelines, type AzureUpstreamFacts, toAzureUpstreamFacts } from '@floway-dev/provider-azure';
import { chatgptPipelines, chatgptService, type ChatGPTServices, type ChatGPTUpstreamFacts, createChatGPTService, toChatGPTUpstreamFacts } from '@floway-dev/provider-chatgpt';
import { claudeCodePipelines, claudeCodeService, type ClaudeCodeServices, type ClaudeCodeUpstreamFacts, createClaudeCodeService, toClaudeCodeUpstreamFacts } from '@floway-dev/provider-claude-code';
import { copilotPipelines, type CopilotServices, type CopilotUpstreamFacts, createCopilotService, toCopilotUpstreamFacts } from '@floway-dev/provider-copilot';
import { customPipelines, type CustomUpstreamFacts, toCustomUpstreamFacts } from '@floway-dev/provider-custom';
import { createKimiCodeService, kimiCodePipelines, type KimiCodeServices, type KimiCodeUpstreamFacts, toKimiCodeUpstreamFacts } from '@floway-dev/provider-kimi-code';
import { createOllamaService, ollamaPipelines, type OllamaServices, type OllamaUpstreamFacts, toOllamaUpstreamFacts } from '@floway-dev/provider-ollama';

export type UpstreamFacts = AzureUpstreamFacts | ChatGPTUpstreamFacts | ClaudeCodeUpstreamFacts | CopilotUpstreamFacts
  | CustomUpstreamFacts | KimiCodeUpstreamFacts | OllamaUpstreamFacts;

export const toUpstreamFacts = (record: StoredUpstreamRecord | UpstreamRecord): UpstreamFacts => {
  switch (record.kind) {
  case 'azure': return toAzureUpstreamFacts(record);
  case 'chatgpt': return toChatGPTUpstreamFacts(record);
  case 'claude-code': return toClaudeCodeUpstreamFacts(record);
  case 'copilot': return toCopilotUpstreamFacts(record);
  case 'custom': return toCustomUpstreamFacts(record);
  case 'kimi-code': return toKimiCodeUpstreamFacts(record);
  case 'ollama': return toOllamaUpstreamFacts(record);
  }
};

export const openaiChatCompletionsProviderTargets = {
  azure: azurePipelines.openaiChatCompletions,
  copilot: copilotPipelines.openaiChatCompletions,
  custom: customPipelines.openaiChatCompletions,
  'kimi-code': kimiCodePipelines.openaiChatCompletions,
  ollama: ollamaPipelines.openaiChatCompletions,
};

export const openaiResponsesProviderTargets = {
  azure: azurePipelines.openaiResponses,
  chatgpt: chatgptPipelines.openaiResponses,
  copilot: copilotPipelines.openaiResponses,
  custom: customPipelines.openaiResponses,
  'kimi-code': kimiCodePipelines.openaiResponses,
  ollama: ollamaPipelines.openaiResponses,
};

export const anthropicMessagesProviderTargets = {
  azure: azurePipelines.anthropicMessages,
  'claude-code': claudeCodePipelines.anthropicMessages,
  copilot: copilotPipelines.anthropicMessages,
  custom: customPipelines.anthropicMessages,
  'kimi-code': kimiCodePipelines.anthropicMessages,
  ollama: ollamaPipelines.anthropicMessages,
};

export const anthropicMessagesCountTokensProviderTargets = {
  azure: azurePipelines.anthropicMessagesCountTokens,
  copilot: copilotPipelines.anthropicMessagesCountTokens,
  custom: customPipelines.anthropicMessagesCountTokens,
  'kimi-code': kimiCodePipelines.anthropicMessagesCountTokens,
  ollama: ollamaPipelines.anthropicMessagesCountTokens,
};

export const geminiGenerateContentProviderTargets = { custom: customPipelines.geminiGenerateContent };
export const geminiGenerateContentCountTokensProviderTargets = { custom: customPipelines.geminiGenerateContentCountTokens };

export const openaiCompletionsProviderTargets = {
  azure: azurePipelines.openaiCompletions,
  custom: customPipelines.openaiCompletions,
  ollama: ollamaPipelines.openaiCompletions,
};

export const openaiEmbeddingsProviderTargets = {
  azure: azurePipelines.openaiEmbeddings,
  copilot: copilotPipelines.openaiEmbeddings,
  custom: customPipelines.openaiEmbeddings,
  ollama: ollamaPipelines.openaiEmbeddings,
};

export const openaiImagesGenerationsProviderTargets = {
  azure: azurePipelines.openaiImagesGenerations,
  copilot: copilotPipelines.openaiImagesGenerations,
  custom: customPipelines.openaiImagesGenerations,
};

export const openaiImagesEditsProviderTargets = {
  azure: azurePipelines.openaiImagesEdits,
  copilot: copilotPipelines.openaiImagesEdits,
  custom: customPipelines.openaiImagesEdits,
};

export const openaiAudioTranscriptionsProviderTargets = {
  azure: azurePipelines.openaiAudioTranscriptions,
  custom: customPipelines.openaiAudioTranscriptions,
  ollama: ollamaPipelines.openaiAudioTranscriptions,
};

export const rerankProviderTargets = { custom: customPipelines.rerank };

export const decisionProviderTargets = {
  azure: azurePipelines.decision,
  copilot: copilotPipelines.decision,
  custom: customPipelines.decision,
  ollama: ollamaPipelines.decision,
};

export const alphaSearchProviderTargets = { chatgpt: chatgptPipelines.alphaSearch, custom: customPipelines.alphaSearch };

const providerTargets = {
  openaiChatCompletions: openaiChatCompletionsProviderTargets,
  openaiResponses: openaiResponsesProviderTargets,
  anthropicMessages: anthropicMessagesProviderTargets,
  anthropicMessagesCountTokens: anthropicMessagesCountTokensProviderTargets,
  geminiGenerateContent: geminiGenerateContentProviderTargets,
  geminiGenerateContentCountTokens: geminiGenerateContentCountTokensProviderTargets,
  openaiCompletions: openaiCompletionsProviderTargets,
  openaiEmbeddings: openaiEmbeddingsProviderTargets,
  openaiImagesGenerations: openaiImagesGenerationsProviderTargets,
  openaiImagesEdits: openaiImagesEditsProviderTargets,
  openaiAudioTranscriptions: openaiAudioTranscriptionsProviderTargets,
  rerank: rerankProviderTargets,
  decision: decisionProviderTargets,
  alphaSearch: alphaSearchProviderTargets,
} satisfies Record<keyof ProviderPipelines, object>;

export const providerSupportsOperation = (kind: UpstreamFacts['kind'], operation: keyof typeof providerTargets): boolean =>
  Object.hasOwn(providerTargets[operation], kind);

export type ProviderRuntimeServices = Omit<CopilotServices & ChatGPTServices & ClaudeCodeServices & OllamaServices & KimiCodeServices, 'fetcher'>;

const createRuntimeServices = (chatgpt: ChatGPTServices['chatgpt'], claudeCode: ClaudeCodeServices['claudeCode']): ProviderRuntimeServices => Object.freeze({
  copilot: createCopilotService(),
  chatgpt,
  claudeCode,
  ollama: createOllamaService(),
  kimiCode: createKimiCodeService(),
});

export const createProviderRuntimeServices = (): ProviderRuntimeServices =>
  createRuntimeServices(createChatGPTService(), createClaudeCodeService());

export const providerRuntimeServices = createRuntimeServices(chatgptService, claudeCodeService);
