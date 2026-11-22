import type { OpenAIAudioTranscriptionRequest } from './audio.ts';
import type { FlagId } from './flags.ts';
import type { OpenAIImagesEditsRequest } from './images.ts';
import type { ProviderModel } from './model.ts';
import type { Fetcher, HeaderEntry, HttpResponseFacts } from '@floway-dev/http';
import type { ManagedStream, Pipeline } from '@floway-dev/pipeline';
import type { AnthropicMessagesPayload, AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import type { DecisionTarget, ProtocolFrame, RerankTarget } from '@floway-dev/protocols/common';
import type { CanonicalDecisionRequest } from '@floway-dev/protocols/decision';
import type { GeminiGenerateContentPayload, GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';
import type { OpenAIChatCompletionsPayloadEx, OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import type { OpenAICompletionsPayload } from '@floway-dev/protocols/openai-completions';
import type { OpenAIEmbeddingsPayload } from '@floway-dev/protocols/openai-embeddings';
import type { OpenAIImagesGenerationsPayload } from '@floway-dev/protocols/openai-images';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesCompactionResultEx, OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import type { CanonicalRerankRequest } from '@floway-dev/protocols/rerank';

export interface ProviderServices {
  readonly fetcher: (upstreamId: string) => Fetcher;
}

export type ProviderModelFacts = Readonly<Omit<ProviderModel, 'enabledFlags'>> & {
  readonly enabledFlags: readonly FlagId[];
};

export const toProviderModelFacts = (model: ProviderModel): ProviderModelFacts => ({
  ...model,
  enabledFlags: Object.freeze([...model.enabledFlags]),
});

export type OpenAIResponsesAction = 'generate' | 'compact';

export interface ProviderInput<Payload> {
  readonly 'provider.model': ProviderModelFacts;
  readonly 'request.headers': readonly HeaderEntry[];
  readonly 'request.payload': Payload;
}

export interface ProviderAnthropicInput extends ProviderInput<Omit<AnthropicMessagesPayload, 'model'>> {
  readonly 'request.anthropicBeta': readonly string[];
}

export interface ProviderResponsesInput extends ProviderInput<Omit<CanonicalOpenAIResponsesPayload, 'model'>> {
  readonly 'request.action': OpenAIResponsesAction;
}

export interface ProviderHttpOutput {
  readonly 'response.http': HttpResponseFacts;
  readonly 'response.modelKey': string;
}

export interface ProviderStreamOutput<Event> extends ProviderHttpOutput {
  readonly 'response.events': ManagedStream<ProtocolFrame<Event>> | undefined;
}

export interface ProviderResponsesOutput extends ProviderStreamOutput<OpenAIResponsesStreamEventEx> {
  readonly 'response.result': OpenAIResponsesCompactionResultEx | undefined;
}

export interface ProviderTargetOutput<Target> extends ProviderHttpOutput {
  readonly 'response.target': Target;
}

export interface ProviderPipelines {
  readonly alphaSearch?: Pipeline<ProviderInput<Record<string, unknown>>, ProviderHttpOutput, ProviderServices>;
  readonly openaiCompletions?: Pipeline<ProviderInput<Omit<OpenAICompletionsPayload, 'model'>>, ProviderHttpOutput, ProviderServices>;
  readonly openaiChatCompletions?: Pipeline<ProviderInput<Omit<OpenAIChatCompletionsPayloadEx, 'model'>>, ProviderStreamOutput<OpenAIChatCompletionsStreamEvent>, ProviderServices>;
  readonly openaiResponses?: Pipeline<ProviderResponsesInput, ProviderResponsesOutput, ProviderServices>;
  readonly anthropicMessages?: Pipeline<ProviderAnthropicInput, ProviderStreamOutput<AnthropicMessagesStreamEventEx>, ProviderServices>;
  readonly anthropicMessagesCountTokens?: Pipeline<ProviderAnthropicInput, ProviderHttpOutput, ProviderServices>;
  readonly geminiGenerateContent?: Pipeline<ProviderInput<GeminiGenerateContentPayload>, ProviderStreamOutput<GeminiGenerateContentStreamEvent>, ProviderServices>;
  readonly geminiGenerateContentCountTokens?: Pipeline<ProviderInput<GeminiGenerateContentPayload>, ProviderHttpOutput, ProviderServices>;
  readonly openaiEmbeddings?: Pipeline<ProviderInput<Omit<OpenAIEmbeddingsPayload, 'model'>>, ProviderHttpOutput, ProviderServices>;
  readonly openaiImagesGenerations?: Pipeline<ProviderInput<Omit<OpenAIImagesGenerationsPayload, 'model'>>, ProviderHttpOutput, ProviderServices>;
  readonly openaiImagesEdits?: Pipeline<ProviderInput<OpenAIImagesEditsRequest>, ProviderHttpOutput, ProviderServices>;
  readonly openaiAudioTranscriptions?: Pipeline<ProviderInput<OpenAIAudioTranscriptionRequest>, ProviderHttpOutput, ProviderServices>;
  readonly rerank?: Pipeline<ProviderInput<CanonicalRerankRequest>, ProviderTargetOutput<RerankTarget>, ProviderServices>;
  readonly decision?: Pipeline<ProviderInput<CanonicalDecisionRequest>, ProviderTargetOutput<DecisionTarget>, ProviderServices>;
}
