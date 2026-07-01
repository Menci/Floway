import type { MessagesPayload } from '@floway-dev/protocols/messages';
import type { ProviderModel } from '@floway-dev/provider';

// Boundary ctx for Claude Code Messages interceptors. The chain runs only on
// the re-mimicry path; callMessages decides shaped-vs-unshaped before
// entering the chain. `upstreamId` is required by synthesize-metadata-user-id
// to derive deterministic device/session ids that stay stable per upstream
// across requests (so prompt-cache hits depend on conversation content only,
// not on per-call randomness).
export interface ClaudeCodeMessagesBoundaryCtx {
  payload: MessagesPayload;
  readonly model: ProviderModel;
  readonly upstreamId: string;
}
