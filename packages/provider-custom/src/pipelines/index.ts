import { alphaSearch } from './alpha-search/call.ts';
import { anthropicMessages } from './anthropic-messages/call.ts';
import { anthropicMessagesCountTokens } from './anthropic-messages/count-tokens.ts';
import { decision } from './decision/call.ts';
import { geminiGenerateContent } from './gemini-generate-content/call.ts';
import { geminiGenerateContentCountTokens } from './gemini-generate-content/count-tokens.ts';
import { openaiAudioTranscriptions } from './openai-audio-transcriptions/call.ts';
import { openaiChatCompletions } from './openai-chat-completions/call.ts';
import { openaiCompletions } from './openai-completions/call.ts';
import { openaiEmbeddings } from './openai-embeddings/call.ts';
import { openaiImagesEdits } from './openai-images-edits/call.ts';
import { openaiImagesGenerations } from './openai-images-generations/call.ts';
import { openaiResponses } from './openai-responses/call.ts';
import { openaiResponsesCompact } from './openai-responses/compact.ts';
import { rerank } from './rerank/call.ts';
import type { ProviderPipelines } from '@floway-dev/provider';

export const customPipelines = Object.freeze({
  alphaSearch,
  anthropicMessages,
  anthropicMessagesCountTokens,
  decision,
  geminiGenerateContent,
  geminiGenerateContentCountTokens,
  openaiAudioTranscriptions,
  openaiChatCompletions,
  openaiCompletions,
  openaiEmbeddings,
  openaiImagesEdits,
  openaiImagesGenerations,
  openaiResponses,
  openaiResponsesCompact,
  rerank,
} satisfies ProviderPipelines);
