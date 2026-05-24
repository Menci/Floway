import type { ResponsesInterceptor } from '../../../interceptors.ts';
import type { ResponsesPayload } from '@floway-dev/protocols/responses';

// Vendor flags that some non-OpenAI Responses-compatible upstreams understand
// to disable internal "thinking". Not part of the OpenAI Responses contract,
// so they ride alongside the typed payload instead of being declared on it.
interface ResponsesVendorReasoningDisableFields {
  thinking?: { type: 'disabled' };
  enable_thinking?: false;
}

type ResponsesPayloadWithVendorReasoningDisable = Omit<ResponsesPayload, 'reasoning'> & ResponsesVendorReasoningDisableFields;

// Opt-in workaround for upstreams where forced `tool_choice` and enabled
// reasoning do not compose. By default this strips OpenAI `reasoning` rather
// than inventing a `none` effort, because upstreams differ on whether `none` is
// accepted. Vendor flags add their documented explicit-disable spellings.
// References:
// - https://api-docs.deepseek.com/guides/thinking_mode
// - https://api-docs.deepseek.com/quick_start/agent_integrations/oh_my_pi
// - https://www.alibabacloud.com/help/en/model-studio/deep-thinking
const hasForcedToolChoice = (payload: ResponsesPayload): boolean => {
  const toolChoice = payload.tool_choice;
  if (toolChoice === undefined || toolChoice === null) return false;
  if (typeof toolChoice === 'string') return toolChoice === 'required';
  return true;
};

const disableResponsesReasoning = (payload: ResponsesPayload, enabledFlags: ReadonlySet<string>): ResponsesPayloadWithVendorReasoningDisable => {
  const { reasoning: _reasoning, ...rest } = payload;
  const out: ResponsesPayloadWithVendorReasoningDisable = rest;
  if (enabledFlags.has('vendor-deepseek')) {
    out.thinking = { type: 'disabled' };
  }
  if (enabledFlags.has('vendor-qwen')) {
    out.enable_thinking = false;
  }
  return out;
};

export const withReasoningDisabledOnForcedToolChoice: ResponsesInterceptor = async (ctx, _request, run) => {
  if (!ctx.enabledFlags.has('disable-reasoning-on-forced-tool-choice')) return await run();
  if (!hasForcedToolChoice(ctx.payload)) return await run();
  ctx.payload = disableResponsesReasoning(ctx.payload, ctx.enabledFlags) as ResponsesPayload;
  return await run();
};
