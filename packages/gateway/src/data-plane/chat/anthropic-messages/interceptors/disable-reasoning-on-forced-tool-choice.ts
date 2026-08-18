
import type { AnthropicMessagesPayloadInterceptor } from './types.ts';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';
import { providerModelOf } from '@floway-dev/provider';

// Opt-in workaround for upstreams where forced `tool_choice` and enabled
// thinking do not compose. Anthropic Messages has a native `thinking: disabled` shape.
const hasForcedToolChoice = (payload: AnthropicMessagesPayload): boolean => {
  const type = payload.tool_choice?.type;
  return type === 'tool' || type === 'any';
};

const disableAnthropicMessagesReasoning = (payload: AnthropicMessagesPayload): AnthropicMessagesPayload => {
  // Strip only the reasoning subfield (`effort`) so structured-output
  // `output_config.format` survives — forced tool choice composes fine with
  // structured output on these upstreams, only with thinking does it not.
  // If output_config becomes empty after the strip, omit it entirely.
  const { output_config, ...rest } = payload;
  const next: AnthropicMessagesPayload = { ...rest, thinking: { type: 'disabled' as const } };
  if (output_config) {
    const { effort: _effort, ...remaining } = output_config;
    if (Object.keys(remaining).length > 0) next.output_config = remaining;
  }
  return next;
};

export const withReasoningDisabledOnForcedToolChoice: AnthropicMessagesPayloadInterceptor = async (ctx, _gatewayCtx, run) => {
  if (!providerModelOf(ctx.candidate).enabledFlags.has('disable-reasoning-on-forced-tool-choice')) return await run();
  if (!hasForcedToolChoice(ctx.payload)) return await run();
  ctx.payload = disableAnthropicMessagesReasoning(ctx.payload);
  return await run();
};
