import { defineCopilotStage } from '../facts.ts';
/**
 * Anthropic Fast Mode is a per-request opt-in carried by `speed: "fast"` on
 * the Anthropic Messages request and echoed back as `usage.speed: "fast"`. Copilot
 * does not speak Fast Mode on the wire — the upstream resolves the tier via
 * the `-fast` raw model id picked by `model-selection.ts` and never echoes
 * `usage.speed`. This stage bridges the two contracts at the Copilot
 * boundary:
 *
 *   - Strip `speed: 'fast' | 'standard'` from the outbound payload. The
 *     value was already consumed by the model selection stage to pick the raw variant
 *     and pre-validate Fast Mode support, so passing it through to Copilot
 *     would just trigger an unknown-field 400 from a strict upstream.
 *   - Leave any other `speed` value untouched. Unknown values mean the
 *     caller is wrong; let Copilot surface the same invalid_request_error
 *     Anthropic itself would, preserving which
 *     field the upstream rejected.
 *   - When the caller asked for Fast Mode, stamp `usage.speed = 'fast'`
 *     onto the initial `message_start` frame on the way out
 *     so downstream sees the marker the billing path (`speed` → tier='fast'
 *     → the `serviceTier: 'fast'` pricing entry) and Anthropic-compatible clients expect.
 *
 * References:
 * - https://docs.claude.com/en/build-with-claude/fast-mode
 * - https://docs.claude.com/en/api/service-tiers
 */
export const handleSpeedFast = defineCopilotStage({
  name: 'copilot.anthropicMessages.handleSpeedFast',
  through: {
    request: { needs: ['request.anthropicMessages'], provides: ['request.anthropicMessages'], consumes: [] },
    response: { needs: ['response.anthropicMessages'], provides: ['response.anthropicMessages'], consumes: [] },
  },
  async execute(facts, scope) {
    const { speed, ...payload } = facts['request.anthropicMessages'];
    const back = await scope.next(speed === 'fast' || speed === 'standard' ? { ...facts, 'request.anthropicMessages': payload } : facts);
    const outcome = back['response.anthropicMessages'];
    if (speed !== 'fast' || outcome.kind !== 'stream') return back;

    const stream = scope.wrapStream(outcome.stream, async function* (source, producer) {
      for await (const item of producer.read(source)) {
        if (!item.ok || item.value.type !== 'message_start') {
          yield item;
          continue;
        }
        const { message } = item.value;
        yield { ok: true, value: { ...item.value, message: { ...message, usage: { ...message.usage, speed: 'fast' as const } } } };
      }
    });
    return { ...back, 'response.anthropicMessages': { kind: 'stream', stream } };
  },
});
