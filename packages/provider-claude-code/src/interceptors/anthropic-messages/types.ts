import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';
import type { ProviderModel } from '@floway-dev/provider';

// Boundary ctx for Claude Code Anthropic Messages interceptors. The chain runs only on
// the re-mimicry path; callAnthropicMessages decides shaped-vs-unshaped before
// entering the chain. `upstreamId` is required by synthesize-metadata-user-id
// to derive deterministic device/session ids that stay stable per upstream
// across requests (so prompt-cache hits depend on conversation content only,
// not on per-call randomness).
export interface AnthropicMessagesBoundaryCtx {
  payload: AnthropicMessagesPayload;
  readonly model: ProviderModel;
  readonly upstreamId: string;
}
