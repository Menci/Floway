import type { ChatCompletionsPayload } from '@floway-dev/protocols/chat-completions';
import type { ProviderModel } from '@floway-dev/provider';

// Boundary ctx for Cursor Chat Completions interceptors. The payload is the
// OpenAI ChatCompletions request body; interceptors mutate it before fetch.ts
// flattens it into the Cursor AgentRunRequest.
export interface ChatCompletionsBoundaryCtx {
  payload: ChatCompletionsPayload;
  headers: Headers;
  readonly model: ProviderModel;
}
