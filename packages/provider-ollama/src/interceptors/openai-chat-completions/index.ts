// Ollama-only OpenAI Chat Completions workarounds. The boundary chain runs
// inside `provider.callOpenAIChatCompletions`, so the gateway main flow never
// learns that Ollama has Chat Completions interceptors at all.
import { withOutputCapRenamed } from './rename-output-cap.ts';
import type { OllamaOpenAIChatCompletionsBoundaryInterceptor } from './types.ts';

export const OLLAMA_OPENAI_CHAT_COMPLETIONS_BOUNDARY = [
  withOutputCapRenamed,
] as const satisfies readonly OllamaOpenAIChatCompletionsBoundaryInterceptor[];
