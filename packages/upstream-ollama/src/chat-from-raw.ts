import type { OllamaRawModel } from './fetch-models.ts';
import type { UpstreamChatModelConfig } from '@floway-dev/upstream';

// Across Ollama's thinking-capable families, only gpt-oss (harmony) renders
// `.ThinkLevel` literally in its chat template — every other family (qwen3,
// deepseek-r1, glm-4, …) reads a boolean `.Think` and ignores the effort
// string. We surface effort uniformly anyway: the gateway has no reliable
// per-family signal to discriminate without baking in a family allowlist that
// drifts as the catalog grows, and an honest `adaptive: true` would force
// operators of effort-respecting families to opt out of the standard preset.
// Operators who need stricter behavior can override `chat.reasoning` in the
// manual row.
export const chatFromOllamaRaw = (raw: OllamaRawModel): UpstreamChatModelConfig | undefined => {
  const chat: UpstreamChatModelConfig = {};

  if (raw.capabilities.has('vision')) {
    chat.modalities = { input: ['text', 'image'], output: ['text'] };
  }

  if (raw.capabilities.has('thinking')) {
    chat.reasoning = { effort: { supported: ['low', 'medium', 'high'], default: 'medium' } };
  }

  return Object.keys(chat).length > 0 ? chat : undefined;
};
