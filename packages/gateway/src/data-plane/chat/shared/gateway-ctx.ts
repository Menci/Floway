import { AffinityRequestContext } from './affinity/index.ts';
import { apiKeyFromContext, type AuthedContext } from '../../../middleware/auth.ts';
import type { ApiKey } from '../../../repo/types.ts';
import { createGatewayCtxFromHono, type CreateGatewayCtxOptions, type GatewayCtx } from '../../shared/gateway-ctx.ts';
import type { StatefulOpenAIResponsesStore } from '../openai-responses/items/store.ts';

// Chat-protocol ctx adds the affinity membrane and the OpenAI Responses item store.
// The store is present on every chat ctx: native OpenAI Responses entries supply a
// persisting factory, non-OpenAI-Responses sources a no-backing scratchpad store, so
// the server-tool shim's request-private state always has a home. Every chat
// HTTP/WS entry constructs this via `createChatGatewayCtxFromHono` and threads
// it through serve → narrow → attempt. Passthrough endpoints (OpenAI
// Embeddings / OpenAI Images / OpenAI Audio Transcriptions / OpenAI
// Completions) have no stored-items concept and stay on plain `GatewayCtx`.
export interface ChatGatewayCtx extends GatewayCtx {
  readonly affinity: AffinityRequestContext;
  readonly store: StatefulOpenAIResponsesStore;
}

// Chat-protocol counterpart of `createGatewayCtxFromHono`. The factory receives
// the authoritative API key. Native OpenAI Responses HTTP and WebSocket entries
// supply a persisting store factory; non-OpenAI-Responses sources supply
// `createNonOpenAIResponsesSourceStore`, so every chat ctx carries a store.
export const createChatGatewayCtxFromHono = (
  c: AuthedContext,
  opts: CreateGatewayCtxOptions,
  storeFactory: (apiKey: ApiKey, requestStartedAt: number) => StatefulOpenAIResponsesStore,
): ChatGatewayCtx => {
  const base = createGatewayCtxFromHono(c, opts);
  return {
    ...base,
    affinity: new AffinityRequestContext(apiKeyFromContext(c).serverSecret),
    store: storeFactory(apiKeyFromContext(c), base.requestStartedAt),
  };
};
