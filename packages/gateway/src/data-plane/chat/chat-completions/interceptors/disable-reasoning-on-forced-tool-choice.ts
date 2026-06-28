import type { ChatCompletionsInterceptor } from './types.ts';
import type { ChatCompletionsPayload } from '@floway-dev/protocols/chat-completions';

// Opt-in workaround for upstreams where forced `tool_choice` and enabled
// reasoning do not compose. Sets the gateway's canonical "no reasoning"
// sentinel `reasoning_effort: 'none'` (also OpenAI's documented disable
// value). Any active Vendor: * flag's last-running normalizer then
// translates that into the vendor's wire form (DeepSeek
// `thinking: {type:'disabled'}`, Qwen `enable_thinking: false`, etc.).
const hasForcedToolChoice = (payload: ChatCompletionsPayload): boolean => {
  const toolChoice = payload.tool_choice;
  if (toolChoice === undefined || toolChoice === null) return false;
  if (typeof toolChoice === 'string') return toolChoice === 'required';
  return true;
};

export const withReasoningDisabledOnForcedToolChoice: ChatCompletionsInterceptor = async (ctx, _gatewayCtx, run) => {
  if (!ctx.candidate.model.enabledFlags.has('disable-reasoning-on-forced-tool-choice')) return await run();
  if (!hasForcedToolChoice(ctx.payload)) return await run();
  ctx.payload = { ...ctx.payload, reasoning_effort: 'none' };
  return await run();
};
