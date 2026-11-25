import type { AzureUpstream } from '../upstream.ts';
import { anthropicMessages, anthropicMessagesCountTokens } from './anthropic-messages/index.ts';
import { decision } from './decision/index.ts';
import { openaiAudioTranscriptions } from './openai-audio-transcriptions/index.ts';
import { openaiChatCompletions } from './openai-chat-completions/index.ts';
import { openaiCompletions } from './openai-completions/index.ts';
import { openaiEmbeddings } from './openai-embeddings/index.ts';
import { openaiImagesEdits } from './openai-images-edits/index.ts';
import { openaiImagesGenerations } from './openai-images-generations/index.ts';
import { openaiResponses, openaiResponsesCompact } from './openai-responses/index.ts';
import type { ProviderPipelines, ProviderServices } from '@floway-dev/provider';

export const azurePipelines = Object.freeze({
  anthropicMessages,
  anthropicMessagesCountTokens,
  decision,
  openaiAudioTranscriptions,
  openaiChatCompletions,
  openaiCompletions,
  openaiEmbeddings,
  openaiImagesEdits,
  openaiImagesGenerations,
  openaiResponses,
  openaiResponsesCompact,
} satisfies ProviderPipelines<ProviderServices, AzureUpstream>);
