import type { OllamaServices } from '../service.ts';
import type { OllamaUpstream } from '../upstream.ts';
import { factSpace } from '@floway-dev/pipeline';
import type { ProviderOperationFacts } from '@floway-dev/provider';

export type OllamaOperation =
  | 'anthropicMessages'
  | 'anthropicMessagesCountTokens'
  | 'decision'
  | 'openaiAudioTranscriptions'
  | 'openaiChatCompletions'
  | 'openaiCompletions'
  | 'openaiEmbeddings'
  | 'openaiResponses'
  | 'openaiResponsesCompact';

export type OllamaFacts = ProviderOperationFacts<OllamaOperation, OllamaUpstream>;
export const { compose, defineStage } = factSpace<OllamaFacts, OllamaServices>();
