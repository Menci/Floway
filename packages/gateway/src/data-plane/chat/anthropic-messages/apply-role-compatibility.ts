import type { Chat } from '../facts.ts';
import { mapKeepingIdentity } from '../shared/structural.ts';
import { defineStage, transform, move } from '@floway-dev/pipeline';

// ── Anthropic Messages ────────────────────────────────────────────────────────────────────

/**
 * The mid-conversation system rewrite, which on this protocol is every inline system message.
 *
 * Anthropic's top-level `payload.system` is the only first-position system slot, so a system
 * message inside `messages` is by construction past the leading run — which is why this reads
 * the same flag as the other protocols' fold but is not that fold: there is no leading run to
 * cross here, and no developer role to trade with.
 */
export const applyRoleCompatibilityToAnthropicMessages = defineStage<
  Chat<'request.chat.anthropicMessages' | 'route.attempt'>,
  Chat<'request.chat.anthropicMessages'>,
  Chat<'response.chat.anthropicMessages'>,
  Chat<'response.chat.anthropicMessages'>
>({
  name: 'applyRoleCompatibility',
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
      if (!facts['route.attempt'].flags.includes('rewrite-mid-conv-system-to-user')) return facts;
      const payload = facts['request.chat.anthropicMessages'];
      const messages = mapKeepingIdentity(payload.messages, message =>
        message.role === 'system' ? { role: 'user' as const, content: message.content } : message);
      return messages === payload.messages
        ? facts
        : { ...facts, 'request.chat.anthropicMessages': move({ ...payload, messages }) };
    },
  })),
});
