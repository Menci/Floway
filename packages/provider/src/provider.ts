import type { FlagDefaults } from './flags.ts';
import type { ModelPrefixConfig } from './model-prefix.ts';
import type { ProviderModel, UpstreamModelsCache, UpstreamProviderKind, UpstreamRecord } from './model.ts';
import type { Fetcher } from './options.ts';
import type { ProviderPipelines } from './pipeline.ts';
import type { ProtocolFrame, RerankTarget } from '@floway-dev/protocols/common';
import type { OpenAIResponsesCompactionResult, OpenAIResponsesStreamEvent } from '@floway-dev/protocols/openai-responses';

// The dispatched action can change independently of the source endpoint's original intent.
export type OpenAIResponsesAction = 'generate' | 'compact';

export type InboundHeaderMatcher = string | RegExp;

export interface Provider {
  upstreamId: string;
  kind: UpstreamProviderKind;
  name: string;
  // Client-authored headers this instance can consume. Strings are exact,
  // ASCII-case-insensitive names; regular expressions run against normalized
  // lowercase names. The gateway applies this at the candidate boundary.
  inboundHeaderAllowlist: readonly InboundHeaderMatcher[];
  disabledPublicModelIds: readonly string[];
  // Per-upstream model name prefix policy mirrored from the source upstream
  // record so registry helpers — routing and listing — read it from the
  // instance instead of re-fetching the row. `null` keeps the bare-id behavior.
  modelPrefix: ModelPrefixConfig | null;
  // The row's persisted catalog snapshot, mirrored so resolution does not pay
  // a second round trip after the row has already been loaded.
  modelsCache: UpstreamModelsCache | null;
  pipelines: ProviderPipelines;
  instance: ProviderInstance;
}

export interface ProviderCallResult {
  response: Response;
  modelKey: string;
}

export interface ProviderRerankCallResult extends ProviderCallResult {
  target: RerankTarget;
}

// Protocol fixtures distinguish decoded frames from an HTTP failure reply.
export type ProviderStreamResult<TEvent> =
  | { ok: true; events: AsyncIterable<ProtocolFrame<TEvent>>; modelKey: string; headers?: Headers }
  | { ok: false; response: Response; modelKey: string };

// The observed output shape follows the dispatched action, independently of caller intent.
export type ProviderOpenAIResponsesResult =
  | { action: 'generate'; ok: true; events: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEvent>>; modelKey: string; headers?: Headers }
  | { action: 'generate'; ok: false; response: Response; modelKey: string }
  | { action: 'compact'; ok: true; result: OpenAIResponsesCompactionResult; modelKey: string }
  | { action: 'compact'; ok: false; response: Response; modelKey: string };

// Per-call options the gateway threads through to the provider.
//
// `fetcher` is the per-upstream proxy-aware indirection for outbound HTTP.
// Every upstream call (data-plane request, OAuth refresh, etc.) must go
// through this fetcher so a single fallback chain governs every leg of the
// call under restricted egress.
//
// `waitUntil` registers a fire-and-forget promise that must outlive the
// response. On workerd it maps to `ExecutionContext.waitUntil` so the
// isolate is not terminated when the response is returned; on Node it is a
// no-op. Providers use it for post-response persistence the caller has
// already stopped waiting on.
//
// `headers` is the ordinary inbound-headers conduit from gateway to provider.
// The gateway filters the source request through the selected provider
// instance's `inboundHeaderAllowlist` before constructing this bag. Protocol-owned
// metadata is carried by its owning invocation boundary and does not widen
// this provider-level policy. Pipeline request shaping uses immutable header-line facts; this bag is the
// transport fixture and control-call boundary.
export interface UpstreamCallOptions {
  fetcher: Fetcher;
  waitUntil: (promise: Promise<unknown>) => void;
  headers: Headers;
  // Providers wrap the dispatch that fires the outbound fetch. Before the
  // first output, the wrapper records its start synchronously ahead of dial,
  // TLS, and CONNECT. Further dispatches after output preserve the measured
  // first-token interval, including internal server-tool continuations.
  // This interval includes data-plane egress and excludes model routing, translation,
  // and stage preparation before dispatch. Candidate iteration clears
  // both timing anchors on failover, so the recorded interval can be shorter
  // than the latency the client observed.
  wrapUpstreamCall: <T>(dispatch: () => Promise<T>) => Promise<T>;
}

export interface AnthropicMessagesUpstreamCallOptions extends UpstreamCallOptions {
  // Anthropic Messages transport metadata has a typed path so it cannot be admitted by
  // an ordinary provider header allowlist or leak from another source
  // protocol that happens to send the same HTTP field name.
  readonly anthropicBeta: readonly string[];
}

export interface ProviderInstance {
  getProvidedModels(fetcher: Fetcher): Promise<readonly ProviderModel[]>;
}

// Static, module-shaped surface each provider package exports. The gateway
// registry keeps a Record<UpstreamProviderKind, ProviderModule> so every
// kind→X dispatch (instance construction, flag defaults) reads its answer
// off the same object. Adding a new dispatch slot means a field here, not
// a parallel per-kind map.
export interface ProviderModule {
  // Instance factory: capture the record and return closures. Sync — any
  // I/O the provider needs (token refresh, state persistence, catalog
  // fetch) happens on demand inside the operation pipelines and the catalog control callback.
  create: (record: UpstreamRecord) => Provider;
  // Exhaustive default map over every catalog flag id for a fresh
  // upstream of this kind; see each provider package's `defaults.ts`.
  defaultFlags: FlagDefaults;
}
