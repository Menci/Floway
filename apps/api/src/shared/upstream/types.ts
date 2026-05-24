// Generic upstream abstraction for configured LLM providers.
// Each upstream owns its base URL, auth headers, and per-endpoint path rules.
//
// Callers identify the endpoint by a logical key (`messages`, `responses`,
// `chat_completions`, `embeddings`, `models`, `messages_count_tokens`); the
// upstream resolves it to the actual path that gets joined onto its base URL.
// Custom OpenAI-compatible upstreams may override individual paths via their
// stored `pathOverrides` config so admins can point one endpoint at a subpath
// without disturbing the others.

export interface UpstreamFetchOptions {
  extraHeaders?: Record<string, string>;
}

export type UpstreamKind = 'copilot' | 'custom' | 'azure';

// Logical endpoint keys used by the gateway-internal upstream dispatcher.
// `messages_count_tokens` is intentionally a logical key: it is a sub-path of
// `messages` and follows the same provider-owned path policy, so the UI never
// exposes it as a separate configurable endpoint.
export type EndpointKey = 'chat_completions' | 'responses' | 'messages' | 'messages_count_tokens' | 'embeddings' | 'images_generations' | 'images_edits' | 'models';

export interface Upstream {
  id: string;
  name: string;
  kind: UpstreamKind;
  // Endpoints this upstream is *configured* to support. Used as a fallback
  // when /models does not declare per-model `supported_endpoints` (Copilot
  // does; most third-party providers do not).
  supportedEndpoints: string[];
  fetch(endpoint: EndpointKey, init: RequestInit, options?: UpstreamFetchOptions): Promise<Response>;
}
