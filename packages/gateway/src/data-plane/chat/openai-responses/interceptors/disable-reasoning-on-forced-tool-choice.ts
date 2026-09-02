
import type { OpenAIResponsesInterceptor } from './types.ts';
import type { OpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';
import { providerModelOf } from '@floway-dev/provider';

// Opt-in workaround for upstreams where forced `tool_choice` and enabled
// reasoning do not compose. Sets the gateway's canonical "no reasoning"
// sentinel `reasoning: { effort: 'none' }` (also OpenAI Responses API's documented
// disable value). Any active Vendor: * flag's last-running normalizer then
// translates that into the vendor's wire form. Sibling fields on the
// `reasoning` object (e.g. `summary`) are dropped — they have no meaning
// when reasoning is disabled.
const hasForcedToolChoice = (payload: OpenAIResponsesPayload): boolean => {
  const toolChoice = payload.tool_choice;
  if (toolChoice === undefined || toolChoice === null) return false;
  if (typeof toolChoice === 'string') return toolChoice === 'required';
  return true;
};

export const withReasoningDisabledOnForcedToolChoice: OpenAIResponsesInterceptor = async (ctx, _gatewayCtx, run) => {
  if (!providerModelOf(ctx.candidate).enabledFlags.has('disable-reasoning-on-forced-tool-choice')) return await run();
  if (!hasForcedToolChoice(ctx.payload)) return await run();
  ctx.payload = { ...ctx.payload, reasoning: { effort: 'none' } };
  return await run();
};
