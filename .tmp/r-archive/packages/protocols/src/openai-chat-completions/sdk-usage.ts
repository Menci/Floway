// Official SDK wire declarations.
// https://github.com/openai/openai-node/blob/7423ac3e9351c46300cd094479cded5551a72eb4/src/resources/completions.ts

export interface CompletionUsage {
  completion_tokens: number;
  prompt_tokens: number;
  total_tokens: number;
  completion_tokens_details?: CompletionUsage.CompletionTokensDetails;
  prompt_tokens_details?: CompletionUsage.PromptTokensDetails;
}

export namespace CompletionUsage {
  export interface CompletionTokensDetails {
    accepted_prediction_tokens?: number;
    audio_tokens?: number;
    reasoning_tokens?: number;
    rejected_prediction_tokens?: number;
    text_tokens?: number;
  }
  export interface PromptTokensDetails {
    audio_tokens?: number;
    cache_write_tokens?: number;
    cached_tokens?: number;
    image_tokens?: number;
    text_tokens?: number;
  }
}
