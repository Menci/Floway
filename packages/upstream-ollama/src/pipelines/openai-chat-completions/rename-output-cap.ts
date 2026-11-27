import type { OpenAIChatCompletionsPayloadEx } from '@floway-dev/protocols/openai-chat-completions';

/**
 * Ollama's Chat Completions shim reads the output cap from the legacy
 * `max_tokens` field alone and maps it onto the `num_predict` option. It has no
 * `max_completion_tokens` field at all, so the modern spelling is dropped on
 * decode and the caller's cap is silently ignored.
 *
 * Rename whenever the modern spelling is the only one present, regardless of
 * where the payload came from: the translator emits it for every cross-protocol
 * request, and a native Chat Completions caller may equally send it alone. A
 * payload that also carries `max_tokens` is left untouched, since the caller
 * already said what Ollama reads.
 *
 * References:
 * - https://github.com/ollama/ollama/blob/9a4b136efefecb51b428d22e79b0f3d15769a1f8/openai/openai.go#L110-L125
 * - https://github.com/ollama/ollama/blob/9a4b136efefecb51b428d22e79b0f3d15769a1f8/openai/openai.go#L753-L755
 */
export const renameOutputCap = (payload: Omit<OpenAIChatCompletionsPayloadEx, 'model'>): Omit<OpenAIChatCompletionsPayloadEx, 'model'> => {
  const { max_completion_tokens: cap, ...rest } = payload;
  return cap === undefined || payload.max_tokens !== undefined ? payload : { ...rest, max_tokens: cap };
};
