import type { CopilotOpenAIChatCompletionsBoundaryInterceptor } from './types.ts';
import type { OpenAIChatCompletionsMessage } from '@floway-dev/protocols/openai-chat-completions';

/**
 * Prime Copilot's content-addressed prompt cache by tagging a small set of
 * messages with `copilot_cache_control: { type: 'ephemeral' }`. Selection:
 * the first two eligible system messages and the last two eligible
 * non-system messages, in original order.
 *
 * The field is a Copilot-private extension to the OpenAI Chat Completions
 * wire shape — kept off the shared `OpenAIChatCompletionsMessage` type so other OpenAI-compatible
 * upstreams never see it on their inbound payloads, and attached here through
 * a Copilot-local view that widens `OpenAIChatCompletionsMessage` with the marker.
 *
 * Probe findings (not obvious from the upstream reference):
 *
 * 1. Cache hits surface ONLY via `usage.prompt_tokens_details.cached_tokens`
 *    in Copilot's responses. There is no `cache_creation_input_tokens` on
 *    Copilot regardless of model family.
 * 2. The markers are needed only to PRIME the cache. Once a prompt prefix has
 *    been primed, subsequent calls hitting the same content (byte-for-byte)
 *    will get a cache hit even when no `copilot_cache_control` is attached.
 *    The cache is content-addressed, not marker-addressed.
 * 3. Copilot internally decides whether to actually cache based on prompt
 *    size (~1.7k tokens observed as the lower bound). We always attach so
 *    short prompts pay nothing and long ones get primed automatically.
 * 4. The marker is silently accepted by every observed model family
 *    (gpt-5.4, gpt-5-mini, gpt-4o-mini, claude-sonnet-4.5). No 4xx, no
 *    schema rejection, no behavioral difference beyond cache priming.
 *
 * Primes every source path routed through Copilot OpenAI Chat Completions — native
 * OpenAI Chat Completions, Anthropic-Messages-via-OpenAI-Chat-Completions, OpenAI-Responses-via-OpenAI-Chat-Completions, and Gemini-generateContent-via-OpenAI-Chat-Completions.
 *
 * References:
 * - https://github.com/caozhiyuan/copilot-api/blob/9be0eb602f1ffee7597741c9af9bc66a68e1a241/src/routes/messages/api-flows.ts#L381-L432
 */

export interface CopilotCacheableMessage extends OpenAIChatCompletionsMessage {
  copilot_cache_control?: { type: 'ephemeral' };
}

const COPILOT_CONTEXT_CACHE_SYSTEM_MARKER_LIMIT = 2;
const COPILOT_CONTEXT_CACHE_NON_SYSTEM_MARKER_LIMIT = 2;
const COPILOT_CONTEXT_CACHE_CONTROL = { type: 'ephemeral' } as const;

const isEligible = (message: OpenAIChatCompletionsMessage): boolean => {
  const { content } = message;
  if (typeof content === 'string') return content.length > 0;
  return Array.isArray(content) && content.length > 0;
};

const selectCacheMarkerIndexes = (messages: readonly OpenAIChatCompletionsMessage[]): number[] => {
  const systemIndexes: number[] = [];
  for (let i = 0; i < messages.length && systemIndexes.length < COPILOT_CONTEXT_CACHE_SYSTEM_MARKER_LIMIT; i++) {
    if (messages[i].role === 'system' && isEligible(messages[i])) systemIndexes.push(i);
  }

  const nonSystemIndexes: number[] = [];
  for (let i = messages.length - 1; i >= 0 && nonSystemIndexes.length < COPILOT_CONTEXT_CACHE_NON_SYSTEM_MARKER_LIMIT; i--) {
    if (messages[i].role !== 'system' && isEligible(messages[i])) nonSystemIndexes.push(i);
  }

  return [...new Set([...systemIndexes, ...nonSystemIndexes])].sort((a, b) => a - b);
};

export const withCacheControlMarkersAttached: CopilotOpenAIChatCompletionsBoundaryInterceptor = async (ctx, _env, run) => {
  const marked = new Set(selectCacheMarkerIndexes(ctx.payload.messages));
  if (marked.size === 0) return await run();

  ctx.payload = {
    ...ctx.payload,
    // A marker is its own object per message, so nothing downstream can carry a change from
    // one to another. The messages that were not selected ride through by identity.
    messages: ctx.payload.messages.map((message, index) => (
      marked.has(index)
        ? { ...message, copilot_cache_control: { ...COPILOT_CONTEXT_CACHE_CONTROL } } as CopilotCacheableMessage
        : message
    )),
  };

  return await run();
};
