import type { MessagesInvocation, RequestContext } from '../../../../llm/interceptors.ts';

/**
 * Copilot's Messages upstream is strict about the `anthropic-beta` header:
 * unknown beta flags cause hard 400s. Our policy:
 *
 *   - When the client supplies its own `anthropic-beta`: filter against the
 *     Copilot allow-list and forward what remains. The client opted into a
 *     specific set of betas; we do not silently add more.
 *   - When the client supplies no `anthropic-beta` AND requested extended
 *     thinking via `thinking.budget_tokens` AND did not request adaptive
 *     thinking: synthesize `interleaved-thinking-2025-05-14` so Copilot
 *     returns thinking blocks alongside the answer.
 *   - Otherwise: emit no `anthropic-beta` header.
 *
 * The split between "client supplied a header" and "we synthesize one" is
 * the load-bearing rule: respect the caller's intent when they expressed
 * one, and only paper over silent omissions with the VSCode default. This
 * also means a client that ships only `context-management-2025-06-27` will
 * not have interleaved auto-added even with non-adaptive budget thinking —
 * matching VSCode Copilot Chat.
 *
 * The filtered value is written into the invocation header bag; the source's
 * typed `MessagesInvocation.anthropicBeta` field is the read-only input.
 *
 * Generic in the run-result type because pre-Path A the equivalent filter
 * ran on every Copilot Messages HTTP exchange (chat AND count_tokens).
 * Keeping a single generic interceptor lets both the streaming Messages
 * target chain (`ExecuteResult<...>`) and the count_tokens chain
 * (`Response`) share one definition.
 *
 * References:
 * - https://docs.anthropic.com/en/api/messages-streaming
 * - https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/resources/messages/messages.ts
 * - https://github.com/caozhiyuan/copilot-api/commit/b2dbf9d57612bdf75e87f71993567bd5315b22b5
 * - https://github.com/caozhiyuan/copilot-api/blob/main/src/services/copilot/create-messages.ts (buildAnthropicBetaHeader)
 */
const ALLOWED_ANTHROPIC_BETAS = new Set([
  'interleaved-thinking-2025-05-14',
  'context-management-2025-06-27',
  'advanced-tool-use-2025-11-20',
]);
const INTERLEAVED_THINKING_BETA = 'interleaved-thinking-2025-05-14';

export const withAnthropicBetaHeaderFiltered = async <TResult>(ctx: MessagesInvocation, _request: RequestContext, run: () => Promise<TResult>): Promise<TResult> => {
  const inbound = ctx.anthropicBeta;
  const hasInbound = inbound !== undefined && inbound.length > 0;

  // Branch 1: caller supplied betas — filter to the Copilot allow-list and
  // forward exactly what survives, including no header at all when nothing
  // survives. Do NOT auto-add interleaved-thinking here, even when the
  // payload's thinking shape would otherwise warrant it: the caller already
  // expressed an opinion about which betas to enable.
  if (hasInbound) {
    const filtered = inbound.filter(value => ALLOWED_ANTHROPIC_BETAS.has(value));
    const unique = [...new Set(filtered)];
    if (unique.length > 0) {
      ctx.headers['anthropic-beta'] = unique.join(',');
    }
    return await run();
  }

  // Branch 2: no inbound betas. Synthesize `interleaved-thinking-2025-05-14`
  // when the caller opted into extended thinking via `budget_tokens` and is
  // not in adaptive mode. Matches VSCode Copilot Chat's default.
  const isAdaptiveThinking = ctx.payload.thinking?.type === 'adaptive';
  if (ctx.payload.thinking?.budget_tokens && !isAdaptiveThinking) {
    ctx.headers['anthropic-beta'] = INTERLEAVED_THINKING_BETA;
  }

  return await run();
};
