import { openAIChatCompletionsPayloadStage } from './payload-stage.ts';
import type { OpenAIChatCompletionsPayloadEx } from '@floway-dev/protocols/openai-chat-completions';

// Opt-in workaround for upstreams where forced `tool_choice` and enabled
// reasoning do not compose. Sets the gateway's canonical "no reasoning"
// sentinel `reasoning_effort: 'none'` (also OpenAI's documented disable
// value). Any active Vendor: * flag's last-running normalizer then
// translates that into the vendor's wire form (DeepSeek
// `thinking: {type:'disabled'}`, Qwen `enable_thinking: false`, etc.).
const hasForcedToolChoice = (payload: OpenAIChatCompletionsPayloadEx): boolean => {
  const toolChoice = payload.tool_choice;
  if (toolChoice === undefined || toolChoice === null) return false;
  if (typeof toolChoice === 'string') return toolChoice === 'required';
  return true;
};

export const disableReasoningOnForcedToolChoice = openAIChatCompletionsPayloadStage('disable-reasoning-on-forced-tool-choice', (payload, flags) =>
  flags.includes('disable-reasoning-on-forced-tool-choice') && hasForcedToolChoice(payload) ? { ...payload, reasoning_effort: 'none' } : payload);
