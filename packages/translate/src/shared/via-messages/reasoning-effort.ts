import type { MessagesPayload } from '@floway-dev/protocols/messages';

// The inverse of `messages-via/reasoning-effort.ts`, shared by every
// `*-via-messages` pair whose source expresses reasoning on the
// OpenAI-canonical discrete effort axis.
//
// Anthropic splits across two slots what OpenAI keeps on one:
// `output_config.effort` carries a level, and `thinking.type: 'disabled'` is
// the off switch. Anthropic's effort scale is `low | medium | high | xhigh |
// max` with no `none` member, so `'none'` is the single value that changes
// slot rather than passing through — routing it to `output_config.effort`
// would send a level the upstream does not define, and dropping it would
// leave a thinking-by-default model reasoning.
// https://platform.claude.com/docs/en/build-with-claude/effort
//
// Whether the target honours the off switch is the target's business, and it
// is not uniform across Claude: thinking-always-on models (Fable 5, Mythos 5,
// Mythos Preview) reject `disabled` with a 400, and Opus 5 accepts it only at
// effort `high` or below. We emit the intent either way, exactly as the native
// `/v1/messages` path forwards a client's own `thinking: {type: 'disabled'}`,
// so a translated request and a native one get the same answer from the same
// model.
// https://platform.claude.com/docs/en/build-with-claude/thinking-troubleshooting#supported-models
//
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
