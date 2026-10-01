import type { MessagesFacts } from '../../chat-facts.ts';
import { defineStage, move } from '@floway-dev/pipeline';
import type { AnthropicMessagesStreamEvent } from '@floway-dev/protocols/anthropic-messages';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { ProviderChatResponse, ProviderChatServices } from '@floway-dev/provider';

/**
 * Anthropic Fast Mode is a per-request opt-in carried by `speed: "fast"` on
 * the Anthropic Messages request and echoed back as `usage.speed: "fast"`. Copilot
 * does not speak Fast Mode on the wire — the upstream resolves the tier via
 * the `-fast` raw model id picked by `model-selection.ts` and never echoes
 * `usage.speed`. This stage bridges the two contracts at the Copilot
 * boundary:
 *
 *   - Strip `speed: 'fast' | 'standard'` from the outbound payload. The
 *     value was already consumed by model selection to pick the raw variant
 *     and pre-validate Fast Mode support, so passing it through to Copilot
 *     would just trigger an unknown-field 400 from a strict upstream.
 *   - Leave any other `speed` value untouched. Unknown values mean the
 *     caller is wrong; let Copilot surface the same invalid_request_error
 *     Anthropic itself would, rather than the gateway lying about which
 *     field the upstream rejected.
 *   - When the caller asked for Fast Mode, stamp `usage.speed = 'fast'`
 *     onto every `message_start` and `message_delta` frame on the way out
 *     so downstream sees the marker the billing path (`speed` → tier='fast'
 *     → the `serviceTier: 'fast'` pricing entry) and Anthropic-compatible clients expect.
 *
 * References:
 * - https://docs.claude.com/en/build-with-claude/fast-mode
 * - https://docs.claude.com/en/api/service-tiers
 */

const stampFastSpeedOntoUsage = async function* (
  frames: AsyncIterable<ProtocolFrame<AnthropicMessagesStreamEvent>>,
): AsyncGenerator<ProtocolFrame<AnthropicMessagesStreamEvent>> {
  for await (const frame of frames) {
    if (frame.type === 'done') {
      yield frame;
      continue;
    }
    const { event } = frame;
    if (event.type === 'message_start') {
      yield eventFrame({
        ...event,
        message: {
          ...event.message,
          usage: { ...event.message.usage, speed: 'fast' },
        },
      });
      continue;
    }
    if (event.type === 'message_delta' && event.usage) {
      yield eventFrame({
        ...event,
        usage: { ...event.usage, speed: 'fast' },
      });
      continue;
    }
    yield frame;
  }
};

export const copilotAnthropicMessagesSpeedFast = defineStage<MessagesFacts, MessagesFacts, ProviderChatResponse<'anthropicMessages'>, ProviderChatResponse<'anthropicMessages'>, ProviderChatServices>({
  name: 'copilotAnthropicMessagesSpeedFast',
  through: { request: { needs: ['request.provider.payload'], consumes: ['request.provider.payload'], provides: ['request.provider.payload'] }, response: { needs: ['response.provider.output'], consumes: ['response.provider.output'], provides: ['response.provider.output'] } },
  execute: async (facts, next, use) => {
    let payload = facts['request.provider.payload'];
    const speed = payload.speed;
    const stamp = speed === 'fast';
    if (speed === 'fast' || speed === 'standard') { const { speed: _, ...withoutSpeed } = payload; payload = withoutSpeed; }
    const back = await next(move({ ...facts, 'request.provider.payload': payload }));
    const output = back['response.provider.output'];
    if (!stamp || output === null || !('kind' in output) || output.kind !== 'stream') return move({ ...back });
    return move({ ...back, 'response.provider.output': { ...output, frames: use.recordProtocolFrames(stampFastSpeedOntoUsage(output.frames)) } });
  },
});
