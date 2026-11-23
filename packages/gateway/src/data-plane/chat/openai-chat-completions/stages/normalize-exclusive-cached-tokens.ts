import { asJsonObject, readJsonNumber } from '../../../../shared/json-helpers.ts';
import { foldsExclusiveCacheTokens } from '../../../shared/telemetry/usage.ts';
import { mapProtocolEvents, rewriteChatFrames } from '../../shared/rewrite-stage.ts';
import type { OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';

// OpenAI includes cached tokens in prompt_tokens. Portkey illustrates an adapter that reports them separately
// while still including them in total_tokens, so the total can identify which accounting convention produced a chunk.
// https://github.com/openai/openai-openapi/blob/d4fb706e6e05d4cc9f1b33ca59b6e4f3e8edd439/openapi.yaml#L51043-L51049
// https://github.com/Portkey-AI/gateway/blob/669825cbe89ee51569918b8f78a9db486fd69dd4/src/providers/anthropic/chatComplete.ts#L612-L627
const restoreInclusiveTokens = (
  chunk: OpenAIChatCompletionsStreamEvent, declaredExclusive: boolean, identity: string,
): OpenAIChatCompletionsStreamEvent => {
  const { usage } = chunk;
  if (!usage || !asJsonObject(usage)) return chunk;
  const inputTokens = readJsonNumber(usage.prompt_tokens);
  const outputTokens = readJsonNumber(usage.completion_tokens);
  if (inputTokens == null || outputTokens == null) return chunk;
  const details = asJsonObject(usage.prompt_tokens_details);
  const cacheRead = readJsonNumber(details?.cached_tokens) ?? 0;
  const cacheWrite = readJsonNumber(details?.cache_creation_input_tokens) ?? readJsonNumber(details?.cache_write_tokens) ?? 0;
  if (cacheRead === 0 && cacheWrite === 0) return chunk;
  const fold = foldsExclusiveCacheTokens(declaredExclusive, {
    inputTokens, outputTokens, cacheRead, cacheWrite,
    totalTokens: readJsonNumber(usage.total_tokens) ?? undefined,
  }, identity);
  return fold ? { ...chunk, usage: { ...usage, prompt_tokens: inputTokens + cacheRead + cacheWrite } } : chunk;
};

export const normalizeExclusiveCachedTokens = rewriteChatFrames(
  'normalizeExclusiveCachedTokens', 'response.openaiChatCompletions', ({ 'route.candidate': candidate }) => mapProtocolEvents<OpenAIChatCompletionsStreamEvent>(
    event => restoreInclusiveTokens(event, candidate.providerModel.enabledFlags.includes('usage-exclusive-cached-tokens'), `${candidate.upstreamId}/${candidate.modelId}`),
  ),
);
