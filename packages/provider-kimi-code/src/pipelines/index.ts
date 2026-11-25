import type { KimiCodeServices } from '../service.ts';
import type { KimiCodeUpstreamFact } from '../upstream-fact.ts';
import { anthropicMessages } from './anthropic-messages/index.ts';
import { anthropicMessagesCountTokens } from './anthropic-messages-count-tokens/index.ts';
import { openaiChatCompletions } from './openai-chat-completions/index.ts';
import { openaiResponses } from './openai-responses/index.ts';
import type { ProviderPipelines } from '@floway-dev/provider';

export const kimiCodePipelines = Object.freeze({ openaiChatCompletions, openaiResponses, anthropicMessages, anthropicMessagesCountTokens }) satisfies ProviderPipelines<KimiCodeServices, KimiCodeUpstreamFact>;
