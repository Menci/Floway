import type { OllamaServices } from '../service.ts';
import { anthropicMessages } from './anthropic-messages/call.ts';
import { anthropicMessagesCountTokens } from './anthropic-messages/count-tokens.ts';
import { decision } from './decision/call.ts';
import { openaiAudioTranscriptions } from './openai-audio-transcriptions/call.ts';
import { openaiChatCompletions } from './openai-chat-completions/call.ts';
import { openaiCompletions } from './openai-completions/call.ts';
import { openaiEmbeddings } from './openai-embeddings/call.ts';
import { openaiResponses } from './openai-responses/call.ts';
import { openaiResponsesCompact } from './openai-responses/compact.ts';
import type { ProviderPipelines } from '@floway-dev/provider';

export const ollamaPipelines = Object.freeze({
  anthropicMessages,
  anthropicMessagesCountTokens,
  decision,
  openaiAudioTranscriptions,
  openaiChatCompletions,
  openaiCompletions,
  openaiEmbeddings,
  openaiResponses,
  openaiResponsesCompact,
} satisfies ProviderPipelines<OllamaServices>);
