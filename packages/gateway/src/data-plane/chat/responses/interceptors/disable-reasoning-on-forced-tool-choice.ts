import type { ResponsesInterceptor } from './types.ts';
import type { ResponsesPayload } from '@floway-dev/protocols/responses';

// Opt-in workaround for upstreams where forced `tool_choice` and enabled
// reasoning do not compose. Sets the gateway's canonical "no reasoning"
// sentinel `reasoning: { effort: 'none' }` (also Responses API's documented
// disable value). Any active Vendor: * flag's last-running normalizer then
// translates that into the vendor's wire form. Sibling fields on the
// `reasoning` object (e.g. `summary`) are dropped — they have no meaning
// when reasoning is disabled.
const hasForcedToolChoice = (payload: ResponsesPayload): boolean => {
  const toolChoice = payload.tool_choice;
  if (toolChoice === undefined || toolChoice === null) return false;
  if (typeof toolChoice === 'string') return toolChoice === 'required';
  return true;
};

export const withReasoningDisabledOnForcedToolChoice: ResponsesInterceptor = async (ctx, _request, run) => {
  if (!ctx.candidate.model.enabledFlags.has('disable-reasoning-on-forced-tool-choice')) return await run();
  if (!hasForcedToolChoice(ctx.payload)) return await run();
  ctx.payload = { ...ctx.payload, reasoning: { effort: 'none' } };
  return await run();
};
