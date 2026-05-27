import type { UpstreamProviderKind } from '../../repo/types.ts';
import type { ChatCompletionsInterceptor, GeminiInterceptor, MessagesCountTokensInterceptor, MessagesInterceptor, ResponsesInterceptor } from '../llm/interceptors.ts';
import type { ChatCompletionsPayload } from '@floway-dev/protocols/chat-completions';
import type { ModelEndpoint, ModelKind, ModelPricing } from '@floway-dev/protocols/common';
import type { EmbeddingsPayload } from '@floway-dev/protocols/embeddings';
import type { ImagesGenerationsPayload } from '@floway-dev/protocols/images';
import type { MessagesPayload } from '@floway-dev/protocols/messages';
import type { ResponsesPayload } from '@floway-dev/protocols/responses';

// The internal model shape: what providers produce and what the registry
// stores. Only fields the data plane actually consumes — to expose downstream
// (id, display_name, owned_by, created, limits) or to drive request-time
// decisions (max_output_tokens as the translation fallback). Provider-internal
// raw fields stay inside that provider's own types and projections; nothing
// upstream-shaped leaks onto this neutral type.
//
// `kind` is the high-level endpoint-family discriminator; `upstreamEndpoints`
// (on UpstreamModel) is the precise per-protocol availability list used by
// the planner. They are linked invariants enforced at the producer boundary:
//   `kind === 'embedding'` ⇔ `upstreamEndpoints === ['embeddings']`
//   `kind === 'image'`     ⇔ `upstreamEndpoints ⊂ {images_generations, images_edits}`
//   `kind === 'chat'`      ⇒ `upstreamEndpoints ⊂ generation endpoints`.
export interface InternalModel {
  id: string;
  display_name?: string;
  owned_by?: string;
  created?: number;
  limits: {
    max_output_tokens?: number;
    max_context_window_tokens?: number;
    max_prompt_tokens?: number;
  };
  kind: ModelKind;
  cost?: ModelPricing;
}

export interface UpstreamModel extends InternalModel {
  upstreamEndpoints: readonly ModelEndpoint[];
  providerData?: unknown;
  enabledFlags: ReadonlySet<string>;
}

export interface ProviderModelRecord {
  upstream: string;
  upstreamName: string;
  providerKind: UpstreamProviderKind;
  provider: ModelProvider;
  upstreamModel: UpstreamModel;
  enabledFlags: ReadonlySet<string>;
  sourceInterceptors?: ProviderSourceInterceptors;
  targetInterceptors?: ProviderTargetInterceptors;
}

// upstreamEndpoints describes which endpoints this model is served by on its
// upstream side; it lives on ResolvedModel for planner-only use. The public
// catalog does not expose upstream endpoint identity — the gateway always
// translates between protocols on the data plane, so downstream clients see
// all source endpoints as available for any generation-capable model.
export interface ResolvedModel extends InternalModel {
  upstreamEndpoints: readonly ModelEndpoint[];
  providers: readonly ProviderModelRecord[];
}

export interface ProviderSourceInterceptors {
  messages?: readonly MessagesInterceptor[];
  responses?: readonly ResponsesInterceptor[];
  chatCompletions?: readonly ChatCompletionsInterceptor[];
  gemini?: readonly GeminiInterceptor[];
}

export interface ProviderTargetInterceptors {
  messages?: readonly MessagesInterceptor[];
  // Separate from `messages` because count_tokens returns a raw upstream
  // Response (no protocol-frame translation), and only the header/payload
  // mutators that pre-Path A applied to count_tokens (vision, initiator,
  // anthropic-beta) belong here. Chat-only mutators like thinking-display
  // promotion and cache_control.scope stripping never ran on count_tokens
  // and stay on `messages`.
  messagesCountTokens?: readonly MessagesCountTokensInterceptor[];
  responses?: readonly ResponsesInterceptor[];
  chatCompletions?: readonly ChatCompletionsInterceptor[];
}

export interface ModelProviderInstance {
  upstream: string;
  providerKind: UpstreamProviderKind;
  name: string;
  provider: ModelProvider;
  sourceInterceptors?: ProviderSourceInterceptors;
  targetInterceptors?: ProviderTargetInterceptors;
  resolveRequestedModelId?(modelId: string): string | undefined;
}

export interface ProviderCallResult {
  response: Response;
  modelKey: string;
}

export interface ModelProvider {
  getProvidedModels(): Promise<readonly UpstreamModel[]>;
  // Resolve pricing for a usage record's `model_key` (the raw upstream model
  // id). Used by aggregation-time cost computation. Public-model-name lookups
  // happen elsewhere by reading `UpstreamModel.cost` directly.
  getPricingForModelKey(modelKey: string): ModelPricing | null;
  // `headers` is the mutable header bag attached to the invocation; target
  // interceptors populate it (vision, initiator, anthropic-beta, ...) and the
  // provider passes it straight through to the upstream fetch unchanged. The
  // shape is uniform across protocols so provider implementations never branch
  // on which protocol they are serving. Image endpoints have no target
  // interceptor stack today, but the parameter stays for interface uniformity.
  callChatCompletions(model: UpstreamModel, body: Omit<ChatCompletionsPayload, 'model'>, signal?: AbortSignal, headers?: Record<string, string>): Promise<ProviderCallResult>;
  callResponses(model: UpstreamModel, body: Omit<ResponsesPayload, 'model'>, signal?: AbortSignal, headers?: Record<string, string>): Promise<ProviderCallResult>;
  // Messages and count_tokens additionally receive the source-derived
  // `anthropicBeta` slice as a typed read-only input separate from the wire
  // headers. Copilot uses it to pick a raw upstream model variant
  // (claude-*-1m-internal vs the standard variant) BEFORE the
  // anthropic-beta target interceptor filters the wire header down to the
  // Copilot allow-list. Variant selection must see the caller's full intent
  // even when the beta value itself is dropped before hitting the wire.
  callMessages(model: UpstreamModel, body: Omit<MessagesPayload, 'model'>, signal?: AbortSignal, headers?: Record<string, string>, anthropicBeta?: readonly string[]): Promise<ProviderCallResult>;
  callMessagesCountTokens(model: UpstreamModel, body: Omit<MessagesPayload, 'model'>, signal?: AbortSignal, headers?: Record<string, string>, anthropicBeta?: readonly string[]): Promise<ProviderCallResult>;
  callEmbeddings(model: UpstreamModel, body: Omit<EmbeddingsPayload, 'model'>, signal?: AbortSignal, headers?: Record<string, string>): Promise<ProviderCallResult>;
  callImagesGenerations(model: UpstreamModel, body: Omit<ImagesGenerationsPayload, 'model'>, signal?: AbortSignal, headers?: Record<string, string>): Promise<ProviderCallResult>;
  // The provider takes ownership of `body` and may mutate it (e.g. append
  // the upstream-specific model/deployment id). Callers must allocate a
  // fresh FormData per call — see images/serve.ts, which builds a new
  // FormData per binding for that reason.
  callImagesEdits(model: UpstreamModel, body: FormData, signal?: AbortSignal, headers?: Record<string, string>): Promise<ProviderCallResult>;
}
