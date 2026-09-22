import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';
import type { ProviderModel, OpenAIResponsesAction } from '@floway-dev/provider';

// Boundary ctx for Codex OpenAI Responses interceptors. The same ctx feeds both the
// streaming `/responses` (action='generate') and the non-streaming compaction
// (action='compact') chains; the terminal switches on `action` to pick the
// wire shape (see provider.ts callOpenAIResponses).
export interface OpenAIResponsesBoundaryCtx {
  payload: CanonicalOpenAIResponsesPayload;
  headers: Headers;
  readonly model: ProviderModel;
  // Mirrors the gateway-side OpenAIResponsesInvocation.action. Interceptors MAY
  // mutate it during the chain to re-route dispatch in the terminal
  // handler — the terminal reads `ctx.action`, not the parameter the
  // provider was originally called with.
  action: OpenAIResponsesAction;
}
