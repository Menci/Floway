import type { MessagesFacts } from '../../chat-facts.ts';
import { defineStage, move } from '@floway-dev/pipeline';

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

export const copilotAnthropicMessagesStripEagerInputStreaming = defineStage<MessagesFacts, MessagesFacts, object, object>({
  name: 'copilotAnthropicMessagesStripEagerInputStreaming',
  through: {
    request: { needs: ['request.provider.payload'], consumes: ['request.provider.payload'], provides: ['request.provider.payload'] },
    response: { needs: [], consumes: [], provides: [] },
  },
  execute: async (facts, next) => {
    let payload = facts['request.provider.payload'];

    if (payload.tools) {
      payload = {
        ...payload, tools: payload.tools.map(tool => {
          const { eager_input_streaming: _, ...rest } = tool as typeof tool & {
            eager_input_streaming?: unknown;
          };
          return rest;
        }),
      };
    }

    return move({ ...await next(move({ ...facts, 'request.provider.payload': payload })) });

  },
});
