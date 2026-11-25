import { defineCopilotStage } from '../facts.ts';
import { move, transform } from '@floway-dev/pipeline';

// The model ID selects Copilot's fast lane. Anthropic clients and metering read the speed marker from message_start.
// https://docs.claude.com/en/build-with-claude/fast-mode
// https://docs.claude.com/en/api/service-tiers
export const handleSpeedFast = defineCopilotStage({
  name: 'copilot.anthropicMessages.handleSpeedFast',
  through: {
    request: { needs: ['request.anthropicMessages'], provides: ['request.anthropicMessages'], consumes: [] },
    response: { needs: ['response.anthropicMessages'], provides: ['response.anthropicMessages'], consumes: [] },
  },
  execute: transform(scope => {
    let fast: boolean;
    return {
      request(facts) {
        const payload = facts['request.anthropicMessages'];
        fast = payload.speed === 'fast';
        if (!fast && payload.speed !== 'standard') return facts;
        const { speed: _speed, ...rest } = payload;
        return { ...facts, 'request.anthropicMessages': move(rest) };
      },
      response(facts) {
        const outcome = facts['response.anthropicMessages'];
        if (!fast || outcome.kind !== 'stream') return facts;

        const stream = scope.wrapStream(outcome.stream, async function* (source) {
          for await (const item of source) {
            if (item.ok && item.value.type === 'message_start') {
              const { message } = item.value;
              yield {
                ok: true,
                value: { ...item.value, message: { ...message, usage: { ...message.usage, speed: 'fast' } } },
              } as const;
            } else {
              yield item;
            }
          }
        });
        return { ...facts, 'response.anthropicMessages': move({ kind: 'stream', stream }) };
      },
    };
  }),
});
