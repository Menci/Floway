import type { Chat } from '../facts.ts';
import { withoutKeys } from '../shared/structural.ts';
import { defineStage, transform, move } from '@floway-dev/pipeline';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';

/** The reasoning sentinel a forced tool choice needs, in the shape this protocol has
 *  natively. `tool` and `any` are the forced choices; `auto` and `none` leave the model free
 *  to reason. */
export const disableReasoningOnForcedToolChoiceForAnthropicMessages = defineStage<
  Chat<'request.chat.anthropicMessages' | 'route.attempt'>,
  Chat<'request.chat.anthropicMessages'>,
  Chat<'response.chat.anthropicMessages'>,
  Chat<'response.chat.anthropicMessages'>
>({
  name: 'disableReasoningOnForcedToolChoice',
  through: {
    request: {
      needs: ['request.chat.anthropicMessages', 'route.attempt'],
      consumes: [],
      provides: ['request.chat.anthropicMessages'],
    },
    response: { needs: ['response.chat.anthropicMessages'], consumes: [], provides: [] },
  },
  execute: transform<
    Chat<'request.chat.anthropicMessages' | 'route.attempt'>,
    Chat<'request.chat.anthropicMessages'>,
    Chat<'response.chat.anthropicMessages'>,
    Chat<'response.chat.anthropicMessages'>
  >(() => ({
    request: facts => {
      if (!facts['route.attempt'].flags.includes('disable-reasoning-on-forced-tool-choice')) {
        return facts;
      }
      const payload = facts['request.chat.anthropicMessages'];
      const choice = payload.tool_choice?.type;
      if (choice !== 'tool' && choice !== 'any') return facts;
      return { ...facts, 'request.chat.anthropicMessages': move(withAnthropicMessagesReasoningDisabled(payload)) };
    },
  })),
});

/** Only the reasoning subfield goes with the sentinel: a forced tool choice composes fine
 *  with structured output on these upstreams, and it is thinking it does not compose with, so
 *  `output_config.format` has to survive. An `output_config` that held nothing but the effort
 *  is nothing at all once the effort is gone, so it goes rather than riding on empty. */
const withAnthropicMessagesReasoningDisabled = (payload: AnthropicMessagesPayload): AnthropicMessagesPayload => {
  const { output_config, ...rest } = payload;
  const next: AnthropicMessagesPayload = { ...rest, thinking: { type: 'disabled' as const } };
  if (output_config !== undefined) {
    const remaining = withoutKeys(output_config, ['effort']);
    if (Object.keys(remaining).length > 0) next.output_config = remaining;
  }
  return next;
};
