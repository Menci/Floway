import type { ModelPrefixConfig } from './model-prefix.ts';
import type { ProviderModel, UpstreamProviderKind } from './model.ts';
import type { Fetcher } from './options.ts';
import type { ChatCompletionsPayload, ChatCompletionsStreamEvent } from '@floway-dev/protocols/chat-completions';
import type { ModelPricing, ProtocolFrame } from '@floway-dev/protocols/common';
import type { CompletionsPayload } from '@floway-dev/protocols/completions';
import type { EmbeddingsPayload } from '@floway-dev/protocols/embeddings';
import type { ImagesGenerationsPayload } from '@floway-dev/protocols/images';
import type { MessagesPayload, MessagesStreamEvent } from '@floway-dev/protocols/messages';
import type { ResponsesPayload, ResponsesResult, ResponsesStreamEvent } from '@floway-dev/protocols/responses';

// Action tag threaded through the Responses pipeline. `generate` is a normal
// streaming /responses turn; `compact` is the summarize-and-replace-history
// turn that some upstreams expose natively (`/v1/responses/compact`,
// chatgpt.com's RemoteCompactionV2 over /codex/responses) and others have to
// simulate. The same `callResponses` method dispatches on this tag, and
// interceptors are free to flip it (the responses-compact-shim turns 'compact'
// into 'generate' so the inner upstream call runs an ordinary summarization
// turn against the SUMMARIZATION_PROMPT).
export type ResponsesAction = 'generate' | 'compact';

export interface Provider {
  upstream: string;
  kind: UpstreamProviderKind;
  name: string;
  // Public model ids the operator switched off for this upstream.
  disabledPublicModelIds: readonly string[];
  // Per-upstream model name prefix policy mirrored from the source upstream
  // record so registry helpers — routing and listing — read it from the
  // instance instead of re-fetching the row. `null` keeps the bare-id behavior.
  modelPrefix: ModelPrefixConfig | null;
  instance: ProviderInstance;
  supportsResponsesItemReference: boolean;
}

export interface ProviderCallResult {
  response: Response;
  modelKey: string;
}

// Streaming endpoints (Messages / Responses / ChatCompletions) return decoded
// protocol frames directly — the provider drives the upstream fetch, parses
// the SSE wire via @floway-dev/protocols, and emits the typed event stream.
// `ok: true` optionally carries the raw upstream `Headers` so the source-side
// `respond` layer can forward them to the downstream client (blocklist in
// gateway `shared/respond.ts` — hop-by-hop, body framing, cookies). Absent
// on lifted/synthesized streams that have no upstream Response behind them,
// matching the same shape on `EventResult`.
// `ok: false` carries the raw upstream Response verbatim so the gateway
// boundary can relay status + body + headers unchanged. Non-2xx-but-not-SSE
// responses throw from the provider as a contract violation (provider always
// forces stream=true on streaming endpoints).
export type ProviderStreamResult<TEvent> =
  | { ok: true; events: AsyncIterable<ProtocolFrame<TEvent>>; modelKey: string; headers?: Headers }
  | { ok: false; response: Response; modelKey: string };

// `action: 'generate'` is a normal streaming /responses turn — its frames
// flow through the per-frame event stream like every other streaming endpoint.
// `action: 'compact'` is non-streaming — the upstream returns a single
// `response.compaction` envelope. Some upstreams expose a native compaction
// endpoint and produce the envelope directly; others synthesize the envelope
// from a regular /responses turn — both return the typed value rather than a
// re-parsed synthesized SSE body. The discriminated result tags which branch
// actually ran so the gateway's shape-lowering can pick between the streaming
// and value-envelope arms; snapshot mode itself reads `invocation.action` (the
// post-chain caller intent), not the result tag.
// The `ok: false` contract is identical to ProviderStreamResult above.
export type ProviderResponsesResult =
  | { action: 'generate'; ok: true; events: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>; modelKey: string; headers?: Headers }
  | { action: 'generate'; ok: false; response: Response; modelKey: string }
  | { action: 'compact'; ok: true; result: ResponsesResult; modelKey: string }
  | { action: 'compact'; ok: false; response: Response; modelKey: string };

// Per-call observation hooks the gateway threads through to the provider.
//
// `fetcher` is the per-upstream proxy-aware indirection for outbound HTTP.
// Every upstream call (data-plane request, OAuth refresh, etc.) must go
// through this fetcher so a single fallback chain governs every leg of the
// call under restricted egress.
//
// `recordUpstreamLatency` measures the precise upstream round-trip — request
// leaves the gateway, response returns to the gateway — and explicitly excludes
// in-process work the provider does around the call (boundary interceptors,
// auth-token refresh, request/response shaping, SSE parsing). The provider is
// required to wrap the actual upstream fetch promise with this helper at least
// once; the gateway throws on a violation so missing wraps fail loud. On
// retries (e.g. invalidate-token-and-redo), only the most recent invocation's
// measurement is kept.
//
// `waitUntil` registers a fire-and-forget promise that must outlive the
// response. On workerd it maps to `ExecutionContext.waitUntil` so the
// isolate is not terminated when the response is returned; on Node it is a
// no-op. Providers use it for post-response persistence the caller has
// already stopped waiting on.
//
// `headers` is the single inbound-headers conduit from gateway to provider.
// The gateway seeds it from the source request's headers. Providers with no
// boundary scrubbing (Azure, custom) thread `opts.headers` straight to the
// upstream wire; providers that scrub (Copilot, Codex) clone via
// `new Headers(opts.headers)` into the boundary ctx so their interceptor
// chain mutates the clone instead of the caller's bag. The gateway owns
// the bag and the provider must not retain a reference past the call.
export interface UpstreamCallOptions {
  fetcher: Fetcher;
  recordUpstreamLatency: <T>(promise: Promise<T>) => Promise<T>;
  waitUntil: (promise: Promise<unknown>) => void;
  headers: Headers;
}

export interface ProviderInstance {
  // Catalog refresh fetches a single resource and never enters the per-request
  // latency budget, so it takes the per-upstream fetcher directly instead of
  // the broader `UpstreamCallOptions` bag the data-plane `call*` methods use.
  getProvidedModels(fetcher: Fetcher): Promise<readonly ProviderModel[]>;
  // Resolve pricing for a usage record's `model_key` (the raw upstream model id).
  getPricingForModelKey(modelKey: string): ModelPricing | null;
  // /v1/completions text completions. Passthrough. Providers whose
  // upstream doesn't expose /v1/completions set `endpoints.completions`
  // to absent in getProvidedModels, so this method is unreachable for
  // those upstreams; the rejecting stubs in those providers are pure
  // defense-in-depth.
  callCompletions(model: ProviderModel, body: Omit<CompletionsPayload, 'model'>, signal: AbortSignal | undefined, opts: UpstreamCallOptions): Promise<ProviderCallResult>;
  // Same `opts.headers` shape across every protocol so provider impls never
  // branch on the protocol when reading inbound headers. `anthropic-beta`
  // lives on `opts.headers` like any other header; providers that need the
  // parsed slice for variant selection (Copilot picks a raw upstream variant
  // before the wire header is filtered down to the Copilot allow-list)
  // re-parse it from `opts.headers.get('anthropic-beta')` themselves.
  callChatCompletions(model: ProviderModel, body: Omit<ChatCompletionsPayload, 'model'>, signal: AbortSignal | undefined, opts: UpstreamCallOptions): Promise<ProviderStreamResult<ChatCompletionsStreamEvent>>;
  callResponses(model: ProviderModel, body: Omit<ResponsesPayload, 'model'>, action: ResponsesAction, signal: AbortSignal | undefined, opts: UpstreamCallOptions): Promise<ProviderResponsesResult>;
  callMessages(model: ProviderModel, body: Omit<MessagesPayload, 'model'>, signal: AbortSignal | undefined, opts: UpstreamCallOptions): Promise<ProviderStreamResult<MessagesStreamEvent>>;
  // count_tokens is non-streaming JSON; the gateway relays the upstream
  // Response verbatim.
  callMessagesCountTokens(model: ProviderModel, body: Omit<MessagesPayload, 'model'>, signal: AbortSignal | undefined, opts: UpstreamCallOptions): Promise<ProviderCallResult>;
  callEmbeddings(model: ProviderModel, body: Omit<EmbeddingsPayload, 'model'>, signal: AbortSignal | undefined, opts: UpstreamCallOptions): Promise<ProviderCallResult>;
  callImagesGenerations(model: ProviderModel, body: Omit<ImagesGenerationsPayload, 'model'>, signal: AbortSignal | undefined, opts: UpstreamCallOptions): Promise<ProviderCallResult>;
  // The provider takes ownership of `body` and may mutate it (e.g. append
  // the upstream-specific model/deployment id). Callers must allocate a
  // fresh FormData per call.
  callImagesEdits(model: ProviderModel, body: FormData, signal: AbortSignal | undefined, opts: UpstreamCallOptions): Promise<ProviderCallResult>;
}
