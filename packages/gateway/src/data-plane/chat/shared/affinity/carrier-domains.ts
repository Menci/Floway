export const CHAT_COMPLETIONS_AFFINITY_DOMAIN = 'chat-completions.reasoning_opaque';
export const MESSAGES_SIGNATURE_AFFINITY_DOMAIN = 'messages.thinking.signature';
export const MESSAGES_REDACTED_AFFINITY_DOMAIN = 'messages.redacted_thinking.data';
export const GEMINI_AFFINITY_DOMAIN = 'gemini.part.thoughtSignature';

export const responsesAffinityDomain = (itemType: string, slot: string): string =>
  `responses.${itemType}.${slot}`;
