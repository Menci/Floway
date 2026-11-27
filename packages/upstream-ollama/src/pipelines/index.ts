import type { OllamaPipelineServices } from '../service.ts';
import { anthropicMessages } from './anthropic-messages/dial.ts';
import { anthropicMessagesCountTokens } from './anthropic-messages-count-tokens/dial.ts';
import { decision } from './decision/dial.ts';
import { compose, MODEL_ENTRY } from './facts.ts';
import { openaiAudioTranscriptions } from './openai-audio-transcriptions/dial.ts';
import { openaiChatCompletions } from './openai-chat-completions/dial.ts';
import { normalizeChatCompletions } from './openai-chat-completions/vendor-normalization.ts';
import { openaiCompletions } from './openai-completions/dial.ts';
import { openaiEmbeddings } from './openai-embeddings/dial.ts';
import { openaiResponses } from './openai-responses/dial.ts';
import { normalizeResponses } from './openai-responses/vendor-normalization.ts';
import { openaiResponsesCompact } from './openai-responses-compact/dial.ts';
import { refreshProbes } from './refresh-probes.ts';
import { httpTerminal, type UpstreamPipeline } from '@floway-dev/upstream';

type OllamaOperation = 'anthropicMessages' | 'anthropicMessagesCountTokens' | 'decision' | 'openaiAudioTranscriptions' | 'openaiChatCompletions' | 'openaiCompletions' | 'openaiEmbeddings' | 'openaiResponses' | 'openaiResponsesCompact';
type OllamaPipelines = { readonly [Op in OllamaOperation]: UpstreamPipeline<Op, OllamaPipelineServices> };

export const ollamaPipelines: OllamaPipelines = Object.freeze({
  anthropicMessages: compose('ollama.anthropicMessages', {
    entry: [...MODEL_ENTRY, 'anthropicMessages'], exit: ['http', 'anthropicMessages'],
    stages: [anthropicMessages, refreshProbes], ending: httpTerminal,
  }),
  anthropicMessagesCountTokens: compose('ollama.anthropicMessagesCountTokens', {
    entry: [...MODEL_ENTRY, 'anthropicMessagesCountTokens'], exit: ['http', 'anthropicMessagesCountTokens'],
    stages: [anthropicMessagesCountTokens], ending: httpTerminal,
  }),
  decision: compose('ollama.decision', {
    entry: [...MODEL_ENTRY, 'decision'], exit: ['http', 'decision'],
    stages: [decision], ending: httpTerminal,
  }),
  openaiAudioTranscriptions: compose('ollama.openaiAudioTranscriptions', {
    entry: [...MODEL_ENTRY, 'openaiAudioTranscriptions'], exit: ['http', 'openaiAudioTranscriptions'],
    stages: [openaiAudioTranscriptions, refreshProbes], ending: httpTerminal,
  }),
  openaiChatCompletions: compose('ollama.openaiChatCompletions', {
    entry: [...MODEL_ENTRY, 'openaiChatCompletions'], exit: ['http', 'openaiChatCompletions'],
    stages: [normalizeChatCompletions, openaiChatCompletions, refreshProbes], ending: httpTerminal,
  }),
  openaiCompletions: compose('ollama.openaiCompletions', {
    entry: [...MODEL_ENTRY, 'openaiCompletions'], exit: ['http', 'openaiCompletions'],
    stages: [openaiCompletions, refreshProbes], ending: httpTerminal,
  }),
  openaiEmbeddings: compose('ollama.openaiEmbeddings', {
    entry: [...MODEL_ENTRY, 'openaiEmbeddings'], exit: ['http', 'openaiEmbeddings'],
    stages: [openaiEmbeddings, refreshProbes], ending: httpTerminal,
  }),
  openaiResponses: compose('ollama.openaiResponses', {
    entry: [...MODEL_ENTRY, 'openaiResponses'], exit: ['http', 'openaiResponses'],
    stages: [normalizeResponses, openaiResponses, refreshProbes], ending: httpTerminal,
  }),
  openaiResponsesCompact: compose('ollama.openaiResponsesCompact', {
    entry: [...MODEL_ENTRY, 'openaiResponsesCompact'], exit: ['http', 'openaiResponsesCompact'],
    stages: [openaiResponsesCompact, refreshProbes], ending: httpTerminal,
  }),
});
