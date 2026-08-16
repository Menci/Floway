// The interceptors three of the four chat protocols share, as stages. Each is written
// against one protocol's payload key and dropped into that protocol's array — one stage
// per (interceptor, protocol) pair, because the payload types differ, but one *rule* each,
// written once here.
//
// What changes from the interceptor form is the two things the pipeline replaced. A stage
// returns the record it hands on instead of assigning to `ctx.payload`, so a rewrite is a
// spread and structural sharing is what makes it cheap — today's code already writes the
// map conditionally, which is the convention that keeps a 49-message conversation costing
// three objects. And `ctx.targetApi` is a declared need rather than an ambient field — array
// position says which chain a stage is in, and what it reads about the protocol it is
// looking at is in the record. The guards themselves are not deleted by that: there is one
// interceptor array, so a rule that must not run on a re-entered request still says so.

import type { Chat } from './facts.ts';
import { defineStage, move, transform } from '@floway-dev/pipeline';
import type { ChatCompletionsPayload } from '@floway-dev/protocols/chat-completions';

/** Role rewrites, in the fixed order `system → developer → system → user`. Later rewrites
 *  are authoritative when flags overlap, and the last step affects only a system message
 *  that appears after the leading run — which is what "mid-conversation" means and why the
 *  fold carries a flag rather than testing the index. */
export const applyRoleCompatibilityToChatCompletions = defineStage<
  Chat<'request.chat.chatCompletions' | 'route.attempt'>,
  Chat<'request.chat.chatCompletions'>,
  Chat<'response.chat.chatCompletions'>,
  Chat<'response.chat.chatCompletions'>
>({
  name: 'applyRoleCompatibility',
  through: {
    request: {
      needs: ['request.chat.chatCompletions', 'route.attempt'],
      consumes: [],
      // Declared even though it will not always be written: a stage that only modifies a
      // field need not write on every run, and `provides \ needs` is the set that must be.
      provides: ['request.chat.chatCompletions'],
    },
    response: { needs: ['response.chat.chatCompletions'], consumes: [], provides: [] },
  },
  execute: transform<
    Chat<'request.chat.chatCompletions' | 'route.attempt'>,
    Chat<'request.chat.chatCompletions'>,
    Chat<'response.chat.chatCompletions'>,
    Chat<'response.chat.chatCompletions'>
  >(() => ({
    request: facts => {
      const rewrite = rolesFor(facts['route.attempt'].flags);
      if (rewrite === null) return facts;                       // the free do-nothing path
      const payload = facts['request.chat.chatCompletions'];
      const messages = rewriteRoles(payload.messages, rewrite);
      // Written conditionally the whole way down, so a conversation this does not touch
      // comes back by identity and the layer costs what the rewrite actually changed.
      return messages === payload.messages
        ? facts
        : { ...facts, 'request.chat.chatCompletions': move({ ...payload, messages }) };
    },
  })),
});

interface RoleRewrite {
  readonly systemToDeveloper: boolean;
  readonly developerToSystem: boolean;
  readonly midConversationSystemToUser: boolean;
}

/** A flag is data on an upstream model, and this is a stage reading it. There is no
 *  category of stage a flag switches on or off. */
const rolesFor = (flags: readonly string[]): RoleRewrite | null => {
  const rewrite: RoleRewrite = {
    systemToDeveloper: flags.includes('rewrite-system-to-developer'),
    developerToSystem: flags.includes('rewrite-developer-to-system'),
    midConversationSystemToUser: flags.includes('rewrite-mid-conv-system-to-user'),
  };
  return rewrite.systemToDeveloper || rewrite.developerToSystem || rewrite.midConversationSystemToUser
    ? rewrite
    : null;
};

type Messages = ChatCompletionsPayload['messages'];

const rewriteRoles = (messages: Messages, rewrite: RoleRewrite): Messages => {
  let crossedLeadingSystemRun = false;
  let changed = false;
  const mapped = messages.map(message => {
    let result = message;
    if (rewrite.systemToDeveloper && result.role === 'system') result = { ...result, role: 'developer' };
    if (rewrite.developerToSystem && result.role === 'developer') result = { ...result, role: 'system' };
    if (!crossedLeadingSystemRun && result.role !== 'system') crossedLeadingSystemRun = true;
    if (rewrite.midConversationSystemToUser && crossedLeadingSystemRun && result.role === 'system') {
      result = { ...result, role: 'user' };
    }
    if (result !== message) changed = true;
    return result;
  });
  return changed ? mapped : messages;
};

/** The reasoning sentinel a forced tool choice needs. Gated by its flag, and the sentinel
 *  is the gateway's canonical form — putting it on the wire in a vendor's shape is the
 *  vendor normalizer's job, which is why this runs above them. */
export const disableReasoningOnForcedToolChoiceForChatCompletions = defineStage<
  Chat<'request.chat.chatCompletions' | 'route.attempt'>,
  Chat<'request.chat.chatCompletions'>,
  Chat<'response.chat.chatCompletions'>,
  Chat<'response.chat.chatCompletions'>
>({
  name: 'disableReasoningOnForcedToolChoice',
  through: {
    request: {
      needs: ['request.chat.chatCompletions', 'route.attempt'],
      consumes: [],
      provides: ['request.chat.chatCompletions'],
    },
    response: { needs: ['response.chat.chatCompletions'], consumes: [], provides: [] },
  },
  execute: transform<
    Chat<'request.chat.chatCompletions' | 'route.attempt'>,
    Chat<'request.chat.chatCompletions'>,
    Chat<'response.chat.chatCompletions'>,
    Chat<'response.chat.chatCompletions'>
  >(() => ({
    request: facts => {
      if (!facts['route.attempt'].flags.includes('disable-reasoning-on-forced-tool-choice')) {
        return facts;
      }
      const payload = facts['request.chat.chatCompletions'];
      if (!isForcedToolChoice(payload.tool_choice)) return facts;
      return { ...facts, 'request.chat.chatCompletions': move({ ...payload, reasoning_effort: 'none' }) };
    },
  })),
});

/** `required`, or a named function. `auto` and `none` leave the model free to reason. */
const isForcedToolChoice = (choice: ChatCompletionsPayload['tool_choice']): boolean =>
  choice === 'required' || (typeof choice === 'object' && choice !== null);

/** Drops a field the upstream would reject as an unknown argument. It runs above the vendor
 *  normalizers so each of them sees the already-stripped canonical payload. */
export const stripPromptCacheKeyForChatCompletions = defineStage<
  Chat<'request.chat.chatCompletions' | 'route.attempt'>,
  Chat<'request.chat.chatCompletions'>,
  Chat<'response.chat.chatCompletions'>,
  Chat<'response.chat.chatCompletions'>
>({
  name: 'stripPromptCacheKey',
  through: {
    request: {
      needs: ['request.chat.chatCompletions', 'route.attempt'],
      consumes: [],
      provides: ['request.chat.chatCompletions'],
    },
    response: { needs: ['response.chat.chatCompletions'], consumes: [], provides: [] },
  },
  execute: transform<
    Chat<'request.chat.chatCompletions' | 'route.attempt'>,
    Chat<'request.chat.chatCompletions'>,
    Chat<'response.chat.chatCompletions'>,
    Chat<'response.chat.chatCompletions'>
  >(() => ({
    request: facts => {
      if (!facts['route.attempt'].flags.includes('strip-prompt-cache-key')) return facts;
      const payload = facts['request.chat.chatCompletions'];
      if (!('prompt_cache_key' in payload)) return facts;
      // Removing a field inside a value is the same move as removing a fact: name it in the
      // destructuring and spread the rest.
      const { prompt_cache_key: dropped, ...rest } = payload;
      void dropped;
      return { ...facts, 'request.chat.chatCompletions': move(rest) };
    },
  })),
});
