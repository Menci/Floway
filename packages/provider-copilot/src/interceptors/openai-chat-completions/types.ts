import type { Interceptor } from '@floway-dev/interceptor';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsPayload, OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import type { ExecuteResult, ProviderModel } from '@floway-dev/provider';

// Boundary ctx for Copilot OpenAI Chat Completions interceptors. See anthropic-messages/types.ts
// for the boundary-isolation rationale.
export interface OpenAIChatCompletionsBoundaryCtx {
  payload: OpenAIChatCompletionsPayload;
  headers: Headers;
  readonly model: ProviderModel;
}

export type CopilotOpenAIChatCompletionsBoundaryInterceptor = Interceptor<
  OpenAIChatCompletionsBoundaryCtx,
  ExecuteResult<ProtocolFrame<OpenAIChatCompletionsStreamEvent>>
>;
