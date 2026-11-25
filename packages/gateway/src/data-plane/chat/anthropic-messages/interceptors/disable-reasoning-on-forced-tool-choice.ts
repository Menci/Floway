import { anthropicMessagesPayloadStage } from './payload-stage.ts';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';

// Opt-in workaround for upstreams where forced `tool_choice` and enabled
// thinking do not compose. Anthropic Messages has a native `thinking: disabled` shape.
export const disableAnthropicMessagesReasoningOnForcedToolChoice = <Payload extends Pick<AnthropicMessagesPayload, 'tool_choice' | 'thinking' | 'output_config'>>(payload: Payload): Payload => {
  const choice = payload.tool_choice?.type;
  if (choice !== 'tool' && choice !== 'any') return payload;
  // Strip only the reasoning subfield (`effort`) so structured-output
  // `output_config.format` survives — forced tool choice composes fine with
  // structured output on these upstreams, only with thinking does it not.
  // If output_config becomes empty after the strip, omit it entirely.
  const next = { ...payload, thinking: { type: 'disabled' as const } };
  const { output_config } = payload;
  if (output_config) {
    const { effort: _effort, ...remaining } = output_config;
    if (Object.keys(remaining).length === 0) delete next.output_config;
    else next.output_config = remaining;
  }
  return next;
};

export const disableReasoningOnForcedToolChoice = anthropicMessagesPayloadStage('disable-reasoning-on-forced-tool-choice', (payload, flags) =>
  flags.includes('disable-reasoning-on-forced-tool-choice') ? disableAnthropicMessagesReasoningOnForcedToolChoice(payload) : payload);
