import type { Interceptor } from '@floway-dev/interceptor';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsPayloadEx, OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import type { ExecuteResult, UpstreamModel } from '@floway-dev/upstream';

// Boundary ctx for Copilot OpenAI Chat Completions interceptors. See anthropic-messages/types.ts
// for the boundary-isolation rationale.
export interface OpenAIChatCompletionsBoundaryCtx {
  payload: OpenAIChatCompletionsPayloadEx;
  headers: Headers;
  readonly model: UpstreamModel;
}

export type CopilotOpenAIChatCompletionsBoundaryInterceptor = Interceptor<
  OpenAIChatCompletionsBoundaryCtx,
  object,
  ExecuteResult<ProtocolFrame<OpenAIChatCompletionsStreamEvent>>
>;
