import type { ChatCompletionsInterceptor } from '../../../interceptors.ts';
import type { ChatCompletionsPayload } from '@floway-dev/protocols/chat-completions';

// Vendor flags that some non-OpenAI Chat Completions-compatible upstreams
// understand to disable internal "thinking". Not part of the OpenAI Chat
// Completions contract, so they ride alongside the typed payload instead of
// being declared on it.
interface ChatCompletionsVendorReasoningDisableFields {
  thinking?: { type: 'disabled' };
  enable_thinking?: false;
}

type ChatCompletionsPayloadWithVendorReasoningDisable = Omit<ChatCompletionsPayload, 'reasoning_effort'> & ChatCompletionsVendorReasoningDisableFields;

// Opt-in workaround for upstreams where forced `tool_choice` and enabled
// reasoning do not compose. By default this strips OpenAI `reasoning_effort`
// rather than inventing a `none` effort, because upstreams differ on whether
// `none` is accepted. Vendor flags add their documented explicit-disable
// spellings.
// References:
// - https://api-docs.deepseek.com/guides/thinking_mode
// - https://api-docs.deepseek.com/quick_start/agent_integrations/oh_my_pi
// - https://www.alibabacloud.com/help/en/model-studio/deep-thinking
const hasForcedToolChoice = (payload: ChatCompletionsPayload): boolean => {
  const toolChoice = payload.tool_choice;
  if (toolChoice === undefined || toolChoice === null) return false;
  if (typeof toolChoice === 'string') return toolChoice === 'required';
  return true;
};

const disableChatCompletionsReasoning = (payload: ChatCompletionsPayload, enabledFlags: ReadonlySet<string>): ChatCompletionsPayloadWithVendorReasoningDisable => {
  const { reasoning_effort: _reasoningEffort, ...rest } = payload;
  const out: ChatCompletionsPayloadWithVendorReasoningDisable = rest;
  if (enabledFlags.has('vendor-deepseek')) {
    out.thinking = { type: 'disabled' };
  }
  if (enabledFlags.has('vendor-qwen')) {
    out.enable_thinking = false;
  }
  return out;
};

export const withReasoningDisabledOnForcedToolChoice: ChatCompletionsInterceptor = async (ctx, _request, run) => {
  if (!ctx.enabledFlags.has('disable-reasoning-on-forced-tool-choice')) return await run();
  if (!hasForcedToolChoice(ctx.payload)) return await run();
  ctx.payload = disableChatCompletionsReasoning(ctx.payload, ctx.enabledFlags) as ChatCompletionsPayload;
  return await run();
};
