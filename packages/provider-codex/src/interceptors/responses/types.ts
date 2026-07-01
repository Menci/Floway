import type { ResponsesPayload } from '@floway-dev/protocols/responses';
import type { ProviderModel, ResponsesAction } from '@floway-dev/provider';

// Boundary ctx for Codex Responses interceptors. The same ctx feeds both the
// streaming `/responses` (action='generate') and the non-streaming compaction
// (action='compact') chains; the terminal switches on `action` to pick the
// wire shape (see provider.ts callResponses).
export interface ResponsesBoundaryCtx {
  payload: ResponsesPayload;
  headers: Headers;
  readonly model: ProviderModel;
  // Mirrors the gateway-side ResponsesInvocation.action. Interceptors MAY
  // mutate it during the chain to re-route dispatch in the terminal
  // handler — the terminal reads `ctx.action`, not the parameter the
  // provider was originally called with.
  action: ResponsesAction;
}
