import type { CopilotUpstream } from '../config.ts';
import type { CopilotServices } from '../service.ts';
import { anthropicMessages } from './anthropic-messages/index.ts';
import { anthropicMessagesCountTokens } from './anthropic-messages-count-tokens/index.ts';
import { decision } from './decision/index.ts';
import { openaiChatCompletions } from './openai-chat-completions/index.ts';
import { openaiEmbeddings } from './openai-embeddings/index.ts';
import { openaiImagesEdits } from './openai-images-edits/index.ts';
import { openaiImagesGenerations } from './openai-images-generations/index.ts';
import { openaiResponses } from './openai-responses/index.ts';
import { openaiResponsesCompact } from './openai-responses-compact/index.ts';
import type { ProviderPipelines } from '@floway-dev/provider';

export const copilotPipelines = Object.freeze({
  anthropicMessages,
  anthropicMessagesCountTokens,
  decision,
  openaiChatCompletions,
  openaiEmbeddings,
  openaiImagesEdits,
  openaiImagesGenerations,
  openaiResponses,
  openaiResponsesCompact,
} satisfies ProviderPipelines<CopilotServices, CopilotUpstream>);
