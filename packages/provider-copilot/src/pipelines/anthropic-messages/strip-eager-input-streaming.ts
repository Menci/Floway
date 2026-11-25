import { defineCopilotStage } from '../facts.ts';
import { move, transform } from '@floway-dev/pipeline';

// Copilot's Messages schema rejects the per-tool eager_input_streaming extension.
// https://github.com/anthropics/anthropic-sdk-typescript/blob/a53f60d59ca904f3e79296586642aac3ce68ae02/src/resources/messages/messages.ts#L1761
export const stripEagerInputStreaming = defineCopilotStage({
  name: 'copilot.anthropicMessages.stripEagerInputStreaming',
  through: {
    request: { needs: ['request.anthropicMessages'], provides: ['request.anthropicMessages'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  execute: transform(() => ({
    request(facts) {
      const payload = facts['request.anthropicMessages'];
      if (!payload.tools) return facts;
      const tools = payload.tools.map(tool => {
        const { eager_input_streaming: _eager, ...rest } = tool as typeof tool & { eager_input_streaming?: unknown };
        return rest;
      });
      const next = { ...payload, tools };
      return { ...facts, 'request.anthropicMessages': move(next) };
    },
  })),
});
