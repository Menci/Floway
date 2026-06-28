import type { MessagesInterceptor } from './types.ts';
import type { MessagesPayload } from '@floway-dev/protocols/messages';

// Opt-in workaround for upstreams where forced `tool_choice` and enabled
// thinking do not compose. Messages has a native `thinking: disabled` shape.
const hasForcedToolChoice = (payload: MessagesPayload): boolean => {
  const type = payload.tool_choice?.type;
  return type === 'tool' || type === 'any';
};

const disableMessagesReasoning = (payload: MessagesPayload): MessagesPayload => {
  // Strip only the reasoning subfield (`effort`) so structured-output
  // `output_config.format` survives — forced tool choice composes fine with
  // structured output on these upstreams, only with thinking does it not.
  // If output_config becomes empty after the strip, omit it entirely.
  const { output_config, ...rest } = payload;
  const next: MessagesPayload = { ...rest, thinking: { type: 'disabled' as const } };
  if (output_config) {
    const { effort: _effort, ...remaining } = output_config;
    if (Object.keys(remaining).length > 0) next.output_config = remaining;
  }
  return next;
};

export const withReasoningDisabledOnForcedToolChoice: MessagesInterceptor = async (ctx, _gatewayCtx, run) => {
  if (!ctx.candidate.model.enabledFlags.has('disable-reasoning-on-forced-tool-choice')) return await run();
  if (!hasForcedToolChoice(ctx.payload)) return await run();
  ctx.payload = disableMessagesReasoning(ctx.payload);
  return await run();
};
