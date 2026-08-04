import type { MessagesPayload } from '@floway-dev/protocols/messages';

// The inverse of `messages-via/reasoning-effort.ts`, shared by every
// `*-via-messages` pair whose source expresses reasoning on the
// OpenAI-canonical discrete effort axis.
//
// Anthropic splits across two slots what OpenAI keeps on one:
// `output_config.effort` carries a level, and `thinking.type: 'disabled'` is
// the off switch. So `'none'` is the single value that changes slot rather
// than passing through — routing it to `output_config.effort` would leave a
// thinking-by-default model reasoning, and dropping it would do the same.
// Every other value is forwarded verbatim; the upstream owns which levels it
// accepts.
export interface MessagesReasoningFields {
  thinking?: NonNullable<MessagesPayload['thinking']>;
  effort?: string;
}

export const messagesReasoningFieldsFromEffort = (effort: string | null | undefined): MessagesReasoningFields => {
  if (effort === 'none') return { thinking: { type: 'disabled' } };
  return effort ? { effort } : {};
};
