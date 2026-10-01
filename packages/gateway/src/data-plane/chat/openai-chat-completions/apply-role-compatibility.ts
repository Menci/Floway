import type { Chat } from '../facts.ts';
import { rolesFor, roleRewriter, type RoleRewrite } from '../shared/role-compatibility.ts';
import { mapKeepingIdentity } from '../shared/structural.ts';
import { defineStage, transform, move } from '@floway-dev/pipeline';
import type { OpenAIChatCompletionsPayload } from '@floway-dev/protocols/openai-chat-completions';

/** Role rewrites, in the fixed order `system → developer → system → user`. Later rewrites
 *  are authoritative when flags overlap, and the last step affects only a system message
 *  that appears after the leading run — which is what "mid-conversation" means. The fold
 *  itself is `roleRewriter`; what is here is the walk over this protocol's messages. */
export const applyRoleCompatibilityToOpenAIChatCompletions = defineStage<
  Chat<'request.chat.openaiChatCompletions' | 'route.attempt'>,
  Chat<'request.chat.openaiChatCompletions'>,
  Chat<'response.chat.openaiChatCompletions'>,
  Chat<'response.chat.openaiChatCompletions'>
>({
  name: 'applyRoleCompatibility',
  through: {
    request: {
      needs: ['request.chat.openaiChatCompletions', 'route.attempt'],
      consumes: [],
      // Declared even though it will not always be written: a stage that only modifies a
      // field need not write on every run, and `provides \ needs` is the set that must be.
      provides: ['request.chat.openaiChatCompletions'],
    },
    response: { needs: ['response.chat.openaiChatCompletions'], consumes: [], provides: [] },
  },
  execute: transform<
    Chat<'request.chat.openaiChatCompletions' | 'route.attempt'>,
    Chat<'request.chat.openaiChatCompletions'>,
    Chat<'response.chat.openaiChatCompletions'>,
    Chat<'response.chat.openaiChatCompletions'>
  >(() => ({
    request: facts => {
      const rewrite = rolesFor(facts['route.attempt'].flags);
      if (rewrite === null) return facts;                       // the free do-nothing path
      const payload = facts['request.chat.openaiChatCompletions'];
      const messages = rewriteOpenAIChatCompletionsRoles(payload.messages, rewrite);
      // Written conditionally the whole way down, so a conversation this does not touch
      // comes back by identity and the layer costs what the rewrite actually changed.
      return messages === payload.messages
        ? facts
        : { ...facts, 'request.chat.openaiChatCompletions': move({ ...payload, messages }) };
    },
  })),
});

type OpenAIChatCompletionsMessages = OpenAIChatCompletionsPayload['messages'];

const rewriteOpenAIChatCompletionsRoles = (messages: OpenAIChatCompletionsMessages, rewrite: RoleRewrite): OpenAIChatCompletionsMessages => {
  const nextRole = roleRewriter(rewrite);
  return mapKeepingIdentity(messages, message => {
    const role = nextRole(message.role);
    return role === message.role ? message : { ...message, role };
  });
};
