import type { Chat } from '../facts.ts';
import { rolesFor, roleRewriter } from '../shared/role-compatibility.ts';
import { mapKeepingIdentity } from '../shared/structural.ts';
import { defineStage, transform, move } from '@floway-dev/pipeline';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesInputItem } from '@floway-dev/protocols/openai-responses';

// ── OpenAI Responses ──────────────────────────────────────────────────────────────────────

/** Role rewrites, in the same fixed order and by the same fold as OpenAI Chat Completions; what is
 *  here is the walk over this protocol's input items. Only a message item carries a role, and
 *  an item that carries none still crosses the leading system run — a reasoning item between
 *  two system messages is what makes the second one mid-conversation. */
export const applyRoleCompatibilityToOpenAIResponses = defineStage<
  Chat<'request.chat.openaiResponses' | 'route.attempt'>,
  Chat<'request.chat.openaiResponses'>,
  Chat<'response.chat.openaiResponses'>,
  Chat<'response.chat.openaiResponses'>
>({
  name: 'applyRoleCompatibility',
  through: {
    request: {
      needs: ['request.chat.openaiResponses', 'route.attempt'],
      consumes: [],
      provides: ['request.chat.openaiResponses'],
    },
    response: { needs: ['response.chat.openaiResponses'], consumes: [], provides: [] },
  },
  execute: transform<
    Chat<'request.chat.openaiResponses' | 'route.attempt'>,
    Chat<'request.chat.openaiResponses'>,
    Chat<'response.chat.openaiResponses'>,
    Chat<'response.chat.openaiResponses'>
  >(() => ({
    request: facts => {
      const rewrite = rolesFor(facts['route.attempt'].flags);
      if (rewrite === null) return facts;                       // the free do-nothing path
      // The key holds what a client may send, whose `input` is a string or a list; this chain
      // runs on the canonical form the entry normalized it to, which is the one a wire takes.
      const payload = facts['request.chat.openaiResponses'] as CanonicalOpenAIResponsesPayload;
      const nextRole = roleRewriter(rewrite);
      const input = mapKeepingIdentity(payload.input, (item): OpenAIResponsesInputItem => {
        if (item.type !== 'message') {
          nextRole(undefined);
          return item;
        }
        const role = nextRole(item.role);
        return role === item.role ? item : { ...item, role };
      });
      return input === payload.input
        ? facts
        : { ...facts, 'request.chat.openaiResponses': move({ ...payload, input }) };
    },
  })),
});
