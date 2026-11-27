import type { Interceptor } from '@floway-dev/interceptor';
import type { OpenAIChatCompletionsPayloadEx, OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import type { UpstreamModel, UpstreamStreamResult } from '@floway-dev/upstream';

// Boundary ctx for Ollama OpenAI Chat Completions interceptors. See the Copilot
// boundary types for the isolation rationale: the chain runs inside
// `provider.callOpenAIChatCompletions`, so the gateway and the protocol
// translators stay unaware of what Ollama's shim needs.
export interface OpenAIChatCompletionsBoundaryCtx {
  payload: Omit<OpenAIChatCompletionsPayloadEx, 'model'>;
  readonly model: UpstreamModel;
}

export type OllamaOpenAIChatCompletionsBoundaryInterceptor = Interceptor<
  OpenAIChatCompletionsBoundaryCtx,
  object,
  UpstreamStreamResult<OpenAIChatCompletionsStreamEvent>
>;
