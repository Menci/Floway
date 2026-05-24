import type { ChatCompletionsInterceptor } from '../../../interceptors.ts';
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

const disableChatCompletionsReasoning = (payload: ChatCompletionsPayload): ChatCompletionsPayload => ({ ...payload, reasoning_effort: 'none' });

export const withReasoningDisabledOnForcedToolChoice: ChatCompletionsInterceptor = async (ctx, _request, run) => {
  if (!ctx.enabledFlags.has('disable-reasoning-on-forced-tool-choice')) return await run();
  if (!hasForcedToolChoice(ctx.payload)) return await run();
  ctx.payload = disableChatCompletionsReasoning(ctx.payload);
  return await run();
};
