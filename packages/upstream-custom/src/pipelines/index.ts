import { alphaSearch } from './alpha-search/index.ts';
import { anthropicMessages } from './anthropic-messages/index.ts';
import { anthropicMessagesCountTokens } from './anthropic-messages-count-tokens/index.ts';
import { decision } from './decision/index.ts';
import { geminiGenerateContent } from './gemini-generate-content/index.ts';
import { geminiGenerateContentCountTokens } from './gemini-generate-content-count-tokens/index.ts';
import { openaiAudioSpeech } from './openai-audio-speech/index.ts';
import { openaiAudioTranscriptions } from './openai-audio-transcriptions/index.ts';
import { openaiChatCompletions } from './openai-chat-completions/index.ts';
import { openaiCompletions } from './openai-completions/index.ts';
import { openaiEmbeddings } from './openai-embeddings/index.ts';
import { openaiImagesEdits } from './openai-images-edits/index.ts';
import { openaiImagesGenerations } from './openai-images-generations/index.ts';
import { openaiResponses } from './openai-responses/index.ts';
import { openaiResponsesCompact } from './openai-responses-compact/index.ts';
import { rerank } from './rerank/index.ts';
import type { UpstreamHttpServices, UpstreamOperation, UpstreamPipeline } from '@floway-dev/upstream';

export const customPipelines = {
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
} satisfies { [Operation in UpstreamOperation]: UpstreamPipeline<Operation, UpstreamHttpServices> };
