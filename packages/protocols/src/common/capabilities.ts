// Pure protocol-level capability types. Runtime computation lives in
// apps/api/src/data-plane/providers/capabilities.ts which re-exports these.

export type ModelEndpoint =
  | 'chat_completions'
  | 'responses'
  | 'messages'
  | 'messages_count_tokens'
  | 'embeddings'
  | 'images_generations'
  | 'images_edits';

export interface ModelCapabilities {
  maxOutputTokens?: number;
  supportedEndpoints: readonly ModelEndpoint[];
}
