import { defineCopilotStage } from '../facts.ts';
import { move, transform } from '@floway-dev/pipeline';
import type { AnthropicMessagesMessage } from '@floway-dev/protocols/anthropic-messages';
const stripExtensions = <Block extends object>(block: Block): Block => {
  if (!('cache_control' in block) || typeof block.cache_control !== 'object' || block.cache_control === null) return block;
  const { cache_control: cache, ...rest } = block;
  const { scope: _scope, ttl: _ttl, ...cacheControl } = cache as Record<string, unknown>;
  return (Object.keys(cacheControl).length === 0 ? rest : { ...rest, cache_control: cacheControl }) as Block;
};
// Copilot rejects cache_control.scope and cache_control.ttl on content blocks and tools.
// https://github.com/caozhiyuan/copilot-api/commit/ce8224c55933f811abe5bf9ba42f9336a7852997
export const stripCacheControlExtensions = defineCopilotStage({
  name: 'copilot.anthropicMessages.stripCacheControlExtensions',
  through: {
    request: { needs: ['request.anthropicMessages'], provides: ['request.anthropicMessages'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  execute: transform(() => ({
    request(facts) {
      const payload = facts['request.anthropicMessages'];
      const { system, tools } = payload;
      const next = {
        ...payload,
        ...(Array.isArray(system) && { system: system.map(stripExtensions) }),
        ...(tools && { tools: tools.map(stripExtensions) }),
        messages: payload.messages.map(message =>
          Array.isArray(message.content) ? { ...message, content: message.content.map(stripExtensions) } as AnthropicMessagesMessage : message),
      };
      return { ...facts, 'request.anthropicMessages': move(next) };
    },
  })),
});
