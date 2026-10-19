interface MaybeErrorFields {
  code?: unknown;
  message?: unknown;
}

// Translated errors recognize OpenAI/Codex patterns and Copilot's message
// fragment. Copilot's native Messages boundary also applies its literal-substring classifier.
// https://github.com/openai/codex/blob/6e5f665feb9b71e1500a5721036fbdb8e871f4b0/codex-rs/codex-api/src/sse/responses.rs#L1138-L1152
// https://github.com/microsoft/debug-gym/blob/a50a8f81fe8035e11947d4d179333d64e305b491/debug_gym/llms/openai.py#L36-L42
// https://github.com/Menci/Floway/blob/3b40210a3b0e4a0a6d59a9ac64f14fc1308af17e/packages/provider-copilot/src/interceptors/anthropic-messages/rewrite-context-window-error.ts#L4
export const isContextExceededError = (error: unknown): boolean => {
  if (error === null || typeof error !== 'object') return false;
  const { code, message } = error as MaybeErrorFields;
  return code === 'context_length_exceeded'
    || code === 'model_max_prompt_tokens_exceeded'
    || typeof message === 'string' && (message.includes('exceeds the context window of this model')
      || message.includes('maximum context length is')
      || message.includes('Request body is too large for model context window'));
};
