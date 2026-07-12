import type { CopilotMessagesBoundaryInterceptor } from './types.ts';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { MessagesStreamEvent } from '@floway-dev/protocols/messages';

/**
 * Anthropic Fast Mode is a per-request opt-in carried by `speed: "fast"` on
 * the Messages request and echoed back as `usage.speed: "fast"`. Copilot
 * does not speak Fast Mode on the wire — the upstream resolves the tier via
 * the `-fast` raw model id picked by `model-selection.ts` and never echoes
 * `usage.speed`. This interceptor bridges the two contracts at the Copilot
 * boundary:
 *
 *   - Strip `speed: 'fast' | 'standard'` from the outbound payload. The
 *     value was already consumed by `callMessages` to pick the raw variant
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
export const withSpeedFast: CopilotMessagesBoundaryInterceptor = async (ctx, _request, run) => {
  const speed = ctx.payload.speed;
  const stampFast = speed === 'fast';

  if (speed === 'fast' || speed === 'standard') {
    const { speed: _stripped, ...payload } = ctx.payload;
    ctx.payload = payload;
  }

  const result = await run();

  if (!stampFast || result.type !== 'events') return result;
  return {
    ...result,
    events: stampFastSpeedOntoUsage(result.events),
  };
};

const stampFastSpeedOntoUsage = async function* (
  frames: AsyncIterable<ProtocolFrame<MessagesStreamEvent>>,
): AsyncGenerator<ProtocolFrame<MessagesStreamEvent>> {
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
