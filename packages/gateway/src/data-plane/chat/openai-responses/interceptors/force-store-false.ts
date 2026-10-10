import type { OpenAIResponsesInterceptor } from './types.ts';
import { providerModelOf } from '@floway-dev/provider';

// Operator policy (`openai-responses-store-false`, off by default and on for
// Copilot upstreams): pin `store: false` on the outbound wire body so a
// stateful OpenAI Responses upstream handles each request statelessly,
// whatever `store` value the caller sent. This is upstream-only policy — the
// gateway's own item store keys off the caller's original `store` value
// captured at the entry boundary (`createOpenAIResponsesHttpStore`,
// `session.createStore`), which runs before this chain and is unaffected by
// the rewrite. See `packages/provider/src/flags.ts` for the flag catalog.
//
// This entry is the single `store: false` forcing. Copilot's upstream
// rejects `store: true` outright with a 400, so Copilot's provider defaults
// the flag on; turning it off for a Copilot upstream makes stateful requests
// fail upstream. Codex additionally pins `store: false` in its own body
// builder (`provider-codex/src/fetch.ts`) regardless of the flag.
//
// Runs only when the final target is OpenAI Responses: translated targets
// (Anthropic Messages, OpenAI Chat Completions) have no `store` concept and
// drop the field during translation.
export const withStoreForcedFalse: OpenAIResponsesInterceptor = async (ctx, _gatewayCtx, run) => {
  if (ctx.targetApi !== 'openaiResponses') return await run();
  if (!providerModelOf(ctx.candidate).enabledFlags.has('openai-responses-store-false')) return await run();

  ctx.payload = { ...ctx.payload, store: false };

  return await run();
};
