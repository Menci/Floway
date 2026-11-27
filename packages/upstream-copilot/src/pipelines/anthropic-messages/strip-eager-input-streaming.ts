import { defineCopilotStage } from '../facts.ts';
import { mapChanged } from '../shared/map-changed.ts';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';

/**
 * `eager_input_streaming` is a per-tool property in the Anthropic Messages API
 * that enables fine-grained tool input streaming. Copilot's native Anthropic Messages
 * target has been observed to reject it with
 * `"tools.N.custom.eager_input_streaming: Extra inputs are not permitted"`, so
 * strip it only at the Copilot target boundary and leave other providers
 * untouched.
 *
 * References:
 * - https://github.com/anthropics/anthropic-sdk-typescript/blob/a53f60d59ca904f3e79296586642aac3ce68ae02/src/resources/messages/messages.ts#L1761
 */

const shapeStripEagerInputStreaming = (payload: AnthropicMessagesPayload): AnthropicMessagesPayload => {
  if (payload.tools === undefined) return payload;
  const tools = mapChanged(payload.tools, tool => {
    if (!('eager_input_streaming' in tool)) return tool;
    const { eager_input_streaming: _stream, ...rest } = tool;
    return rest;
  });
  return tools === payload.tools ? payload : { ...payload, tools };
};

export const stripEagerInputStreaming = defineCopilotStage({
  name: 'copilot.anthropicMessages.stripEagerInputStreaming',
  through: {
    request: { needs: ['anthropicMessages'], provides: ['anthropicMessages'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const payload = facts.anthropicMessages;
    const updated = shapeStripEagerInputStreaming(payload);
    return await scope.next(updated === payload ? facts : { ...facts, anthropicMessages: updated });
  },
});
