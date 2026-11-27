import type { OpenAIAudioTranscriptionRequest } from './audio.ts';
import type { FlagDefaults } from './flags.ts';
import type { OpenAIImagesEditsRequest } from './images.ts';
import type { UpstreamModelConfig } from './model-config.ts';
import type { UpstreamModel, UpstreamKind, UpstreamRecord } from './model.ts';
import type { Fetcher } from './options.ts';
import type { HttpHead } from './result.ts';
import type { UpstreamScheduledOptions } from './scheduled.ts';
import type { AnthropicMessagesPayload, AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import type { DecisionTarget, ProtocolFrame, RerankTarget } from '@floway-dev/protocols/common';
import type { CanonicalDecisionRequest } from '@floway-dev/protocols/decision';
import type { GeminiGenerateContentPayload, GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';
import type { OpenAIChatCompletionsPayloadEx, OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import type { OpenAICompletionsPayload } from '@floway-dev/protocols/openai-completions';
import type { OpenAIEmbeddingsPayload } from '@floway-dev/protocols/openai-embeddings';
import type { OpenAIImagesGenerationsPayload } from '@floway-dev/protocols/openai-images';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesCompactionResultEx, OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import type { CanonicalRerankRequest } from '@floway-dev/protocols/rerank';

// Action tag threaded through the OpenAI Responses pipeline. `generate` is a normal
// streaming /responses turn; `compact` is the summarize-and-replace-history
// turn that some upstreams expose natively (`/v1/responses/compact`,
// chatgpt.com's RemoteCompactionV2 over /codex/responses) and others have to
// simulate. The same `callOpenAIResponses` method dispatches on this tag, and
// interceptors are free to flip it (the openai-responses-compact-shim turns
// 'compact' into 'generate' so the inner upstream call can summarize through
// an appended cache-sharing user request, with one legacy system-prompt retry
// when the first response contains no assistant text).
export type OpenAIResponsesAction = 'generate' | 'compact';

export type InboundHeaderMatcher = string | RegExp;

export interface Upstream {
  upstreamId: string;
  kind: UpstreamKind;
  name: string;
  // Client-authored headers this instance can consume. Strings are exact,
  // ASCII-case-insensitive names; regular expressions run against normalized
  // lowercase names. The gateway applies this at the candidate boundary.
  inboundHeaderAllowlist: readonly InboundHeaderMatcher[];
  instance: UpstreamInstance;
}

export interface UpstreamCallResult {
  http: Response;
  modelKey: string;
}

export interface UpstreamRerankCallResult extends UpstreamCallResult {
  target: RerankTarget;
}

// The target rides back so the serve layer knows which dialect shaped the
// response and can pick the matching parser.
export interface UpstreamDecisionCallResult extends UpstreamCallResult {
  target: DecisionTarget;
}

// Streaming endpoints (Anthropic Messages / OpenAI Responses / OpenAI Chat Completions) return decoded
// protocol frames directly — the provider drives the upstream fetch, parses
// the SSE wire via @floway-dev/protocols, and emits the typed event stream.
// A successful stream carries the head of the HTTP response that opened it.
// A locally synthesized stream can omit it. A failed call retains the raw
// response so the gateway can consume and relay its body.
export type UpstreamStreamResult<TEvent> =
  | { ok: true; events: AsyncIterable<ProtocolFrame<TEvent>>; modelKey: string; http?: HttpHead }
  | ({ ok: false } & UpstreamCallResult);

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
// The `ok: false` contract is identical to UpstreamStreamResult above.
export type UpstreamCompactionResult =
  | { ok: true; result: OpenAIResponsesCompactionResultEx; modelKey: string; http: HttpHead }
  | ({ ok: false } & UpstreamCallResult);

export type UpstreamOpenAIResponsesResult =
  | ({ action: 'generate' } & UpstreamStreamResult<OpenAIResponsesStreamEventEx>)
  | ({ action: 'compact' } & UpstreamCompactionResult);

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
// this provider-level policy. A provider may clone and mutate the bag for
// request-specific wire shaping, but must not retain the gateway-owned
// reference past the call.
export interface UpstreamCallOptions {
  fetcher: Fetcher;
  waitUntil: (promise: Promise<unknown>) => void;
  headers: Headers;
  // Providers wrap the dispatch that fires the outbound fetch. Before the
  // first output, the wrapper records its start synchronously ahead of dial,
  // TLS, and CONNECT. Further dispatches after output preserve the measured
  // first-token interval, including internal server-tool continuations.
  // This interval includes data-plane egress and excludes model routing, translation,
  // and interceptor preparation before dispatch. Candidate iteration clears
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

export interface UpstreamInstance {
  runScheduledTask(options: UpstreamScheduledOptions): Promise<void>;
  // Catalog refresh fetches a single resource and never enters the per-request
  // latency budget, so it takes the per-upstream fetcher directly instead of
  // the broader `UpstreamCallOptions` bag the data-plane `call*` methods use.
  getModels(fetcher: Fetcher, manualModels?: readonly UpstreamModelConfig[]): Promise<readonly UpstreamModel[]>;
  callAlphaSearch(model: UpstreamModel, body: Record<string, unknown>, signal: AbortSignal | undefined, opts: UpstreamCallOptions): Promise<UpstreamCallResult>;
  // /v1/completions text completions. Passthrough. Providers whose
  // upstream doesn't expose /v1/completions set `endpoints.openaiCompletions`
  // to absent in getModels, so this method is unreachable for
  // those upstreams; the rejecting stubs in those providers are pure
  // defense-in-depth.
  callOpenAICompletions(model: UpstreamModel, body: Omit<OpenAICompletionsPayload, 'model'>, signal: AbortSignal | undefined, opts: UpstreamCallOptions): Promise<UpstreamCallResult>;
  callOpenAIChatCompletions(model: UpstreamModel, body: Omit<OpenAIChatCompletionsPayloadEx, 'model'>, signal: AbortSignal | undefined, opts: UpstreamCallOptions): Promise<UpstreamStreamResult<OpenAIChatCompletionsStreamEvent>>;
  callOpenAIResponses(model: UpstreamModel, body: Omit<CanonicalOpenAIResponsesPayload, 'model'>, action: OpenAIResponsesAction, signal: AbortSignal | undefined, opts: UpstreamCallOptions): Promise<UpstreamOpenAIResponsesResult>;
  callAnthropicMessages(model: UpstreamModel, body: Omit<AnthropicMessagesPayload, 'model'>, signal: AbortSignal | undefined, opts: AnthropicMessagesUpstreamCallOptions): Promise<UpstreamStreamResult<AnthropicMessagesStreamEventEx>>;
  // Gemini's native REST surface carries the model id and the action in the
  // URL path (`models/{model}:streamGenerateContent?alt=sse`) rather than in
  // the body, so the call takes the payload exactly as the client shaped it.
  // The gateway always asks for the streaming action; a non-streaming client
  // is collected from those frames. countTokens answers one JSON body and is
  // relayed verbatim; the provider wraps the payload in the envelope its
  // upstream expects.
  callGeminiGenerateContent(model: UpstreamModel, body: GeminiGenerateContentPayload, signal: AbortSignal | undefined, opts: UpstreamCallOptions): Promise<UpstreamStreamResult<GeminiGenerateContentStreamEvent>>;
  callGeminiGenerateContentCountTokens(model: UpstreamModel, body: GeminiGenerateContentPayload, signal: AbortSignal | undefined, opts: UpstreamCallOptions): Promise<UpstreamCallResult>;
  // count_tokens is non-streaming JSON; the gateway relays the upstream
  // Response verbatim.
  callAnthropicMessagesCountTokens(model: UpstreamModel, body: Omit<AnthropicMessagesPayload, 'model'>, signal: AbortSignal | undefined, opts: AnthropicMessagesUpstreamCallOptions): Promise<UpstreamCallResult>;
  callOpenAIEmbeddings(model: UpstreamModel, body: Omit<OpenAIEmbeddingsPayload, 'model'>, signal: AbortSignal | undefined, opts: UpstreamCallOptions): Promise<UpstreamCallResult>;
  callOpenAIImagesGenerations(model: UpstreamModel, body: Omit<OpenAIImagesGenerationsPayload, 'model'>, signal: AbortSignal | undefined, opts: UpstreamCallOptions): Promise<UpstreamCallResult>;
  callOpenAIImagesEdits(model: UpstreamModel, request: OpenAIImagesEditsRequest, signal: AbortSignal | undefined, opts: UpstreamCallOptions): Promise<UpstreamCallResult>;
  callOpenAIAudioTranscriptions(model: UpstreamModel, request: OpenAIAudioTranscriptionRequest, signal: AbortSignal | undefined, opts: UpstreamCallOptions): Promise<UpstreamCallResult>;
  callRerank(model: UpstreamModel, request: CanonicalRerankRequest, signal: AbortSignal | undefined, opts: UpstreamCallOptions): Promise<UpstreamRerankCallResult>;
  callDecision(model: UpstreamModel, request: CanonicalDecisionRequest, signal: AbortSignal | undefined, opts: UpstreamCallOptions): Promise<UpstreamDecisionCallResult>;
}

// Static, module-shaped surface each provider package exports. The gateway
// registry keeps a Record<UpstreamKind, UpstreamModule> so every
// kind→X dispatch (instance construction, flag defaults) reads its answer
// off the same object. Adding a new dispatch slot means a field here, not
// a parallel per-kind map.
export interface UpstreamModule {
  // Instance factory: capture the record and return closures. Sync — any
  // I/O the provider needs (token refresh, state persistence, catalog
  // fetch) happens on demand inside the per-request methods on the
  // returned UpstreamInstance.
  create: (record: UpstreamRecord) => Upstream;
  // Exhaustive default map over every catalog flag id for a fresh
  // upstream of this kind; see each provider package's `defaults.ts`.
  defaultFlags: FlagDefaults;
}
