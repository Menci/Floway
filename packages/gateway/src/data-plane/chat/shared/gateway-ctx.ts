import { AffinityRequestContext } from './affinity/index.ts';
import { createSidecarCodecFactory, type SidecarCodecFactory } from './sidecar-codec.ts';
import { apiKeyFromContext, type AuthedContext } from '../../../middleware/auth.ts';
import type { ApiKey } from '../../../repo/types.ts';
import { createGatewayCtxFromHono, type CreateGatewayCtxOptions, type GatewayCtx } from '../../shared/gateway-ctx.ts';
import type { OpenAIResponsesStatefulStore } from '../openai-responses/items/store.ts';

// Chat-protocol ctx adds affinity, signed sidecars, and the OpenAI Responses item store.
// The store is present on every chat ctx: native OpenAI Responses entries supply a
// persisting factory, non-OpenAI-Responses sources a no-backing store. Every chat
// HTTP/WS entry constructs this via `createChatGatewayCtxFromHono` and threads
// it through serve → narrow → attempt. Passthrough endpoints (OpenAI
// Embeddings / OpenAI Images / OpenAI Audio Transcriptions / OpenAI
// Completions) have no stored-items concept and stay on plain `GatewayCtx`.
export interface ChatGatewayCtx extends GatewayCtx {
  readonly affinity: AffinityRequestContext;
  readonly sidecarCodecFactory: SidecarCodecFactory;
  readonly store: OpenAIResponsesStatefulStore;
}

// Chat-protocol counterpart of `createGatewayCtxFromHono`. The factory receives
// the authoritative API key. Native OpenAI Responses HTTP and WebSocket entries
// supply a persisting store factory; non-OpenAI-Responses sources supply
// `createNonOpenAIResponsesSourceStore`, so every chat ctx carries a store.
export const createChatGatewayCtxFromHono = (
  c: AuthedContext,
  opts: CreateGatewayCtxOptions,
  storeFactory: (apiKey: ApiKey, requestStartedAt: number) => OpenAIResponsesStatefulStore,
): ChatGatewayCtx => {
  const base = createGatewayCtxFromHono(c, opts);
  const apiKey = apiKeyFromContext(c);
  return {
    ...base,
    affinity: new AffinityRequestContext(apiKey.serverSecret),
    sidecarCodecFactory: createSidecarCodecFactory(apiKey.serverSecret),
    store: storeFactory(apiKey, base.requestStartedAt),
  };
};
