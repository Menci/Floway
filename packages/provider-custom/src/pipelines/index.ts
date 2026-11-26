import type { CustomUpstream } from '../upstream.ts';
import { alphaSearch } from './alpha-search/index.ts';
import { anthropicMessages, anthropicMessagesCountTokens } from './anthropic-messages/index.ts';
import { decision } from './decision/index.ts';
import { geminiGenerateContent, geminiGenerateContentCountTokens } from './gemini-generate-content/index.ts';
import { openaiAudioSpeech } from './openai-audio-speech/index.ts';
import { openaiAudioTranscriptions } from './openai-audio-transcriptions/index.ts';
import { openaiChatCompletions } from './openai-chat-completions/index.ts';
import { openaiCompletions } from './openai-completions/index.ts';
import { openaiEmbeddings } from './openai-embeddings/index.ts';
import { openaiImagesEdits } from './openai-images-edits/index.ts';
import { openaiImagesGenerations } from './openai-images-generations/index.ts';
import { openaiResponses, openaiResponsesCompact } from './openai-responses/index.ts';
import { rerank } from './rerank/index.ts';
import type { ProviderPipelines, ProviderServices } from '@floway-dev/provider';

export const customPipelines = Object.freeze({
  alphaSearch,
  anthropicMessages,
  anthropicMessagesCountTokens,
  decision,
  geminiGenerateContent,
  geminiGenerateContentCountTokens,
  openaiAudioSpeech,
  openaiAudioTranscriptions,
  openaiChatCompletions,
  openaiCompletions,
  openaiEmbeddings,
  openaiImagesEdits,
  openaiImagesGenerations,
  openaiResponses,
  openaiResponsesCompact,
  rerank,
} satisfies ProviderPipelines<ProviderServices, CustomUpstream>);
