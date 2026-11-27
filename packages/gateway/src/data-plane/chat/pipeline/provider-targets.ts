import type { ChatOperation } from './facts.ts';
import type { UpstreamKind } from '@floway-dev/upstream';
import { azurePipelines } from '@floway-dev/upstream-azure';
import { chatgptPipelines } from '@floway-dev/upstream-chatgpt';
import { claudeCodePipelines } from '@floway-dev/upstream-claude-code';
import { copilotPipelines } from '@floway-dev/upstream-copilot';
import { customPipelines } from '@floway-dev/upstream-custom';
import { kimiCodePipelines } from '@floway-dev/upstream-kimi-code';
import { ollamaPipelines } from '@floway-dev/upstream-ollama';

export const providerTargets = {
  anthropicMessages: {
    azure: azurePipelines.anthropicMessages,
    'claude-code': claudeCodePipelines.anthropicMessages,
    copilot: copilotPipelines.anthropicMessages,
    custom: customPipelines.anthropicMessages,
    'kimi-code': kimiCodePipelines.anthropicMessages,
    ollama: ollamaPipelines.anthropicMessages,
  },
  geminiGenerateContent: {
    custom: customPipelines.geminiGenerateContent,
  },
  openaiChatCompletions: {
    azure: azurePipelines.openaiChatCompletions,
    copilot: copilotPipelines.openaiChatCompletions,
    custom: customPipelines.openaiChatCompletions,
    'kimi-code': kimiCodePipelines.openaiChatCompletions,
    ollama: ollamaPipelines.openaiChatCompletions,
  },
  openaiResponses: {
    azure: azurePipelines.openaiResponses,
    chatgpt: chatgptPipelines.openaiResponses,
    copilot: copilotPipelines.openaiResponses,
    custom: customPipelines.openaiResponses,
    'kimi-code': kimiCodePipelines.openaiResponses,
    ollama: ollamaPipelines.openaiResponses,
  },
} as const;

export const hasProviderTarget = (operation: ChatOperation, kind: UpstreamKind): boolean =>
  Object.hasOwn(providerTargets[operation], kind);
