// The chat family's fact space. Four source protocols, ten translation directions between
// them, and one shared array of stages that every chain runs.
//
// Two things the key layout says that the old context object could not. Each protocol has
// its own request key and its own response key, so a translation *consumes* the source and
// *provides* the target, and which protocol a stage is looking at is a declared need rather
// than an ambient field on a mutable context. That is visibility and checkability, not the
// deletion of the guards themselves — each is still made, by position where it is about a wire
// and by this key where it is about what the client spoke. And `ingress.*` is what the client asked for: it survives
// the switch to whatever protocol the upstream turned out to speak, which is why
// `wantsStream` is four disjoint keys rather than one shared one.

import type { Failure, GatewayFacts } from '../pipeline/facts.ts';
import type { ChatCompletionsPayload } from '@floway-dev/protocols/chat-completions';
import type { GeminiPayload } from '@floway-dev/protocols/gemini';
import type { MessagesPayload } from '@floway-dev/protocols/messages';
import type { ResponsesPayload } from '@floway-dev/protocols/responses';

/** The four protocols a client can speak here. Gemini is source-only: nothing translates
 *  into it, so by the ruling it contributes one pipeline rather than two — a source role
 *  and no target role. */
export type ChatSourceProtocol = 'chatCompletions' | 'messages' | 'responses' | 'gemini';

export interface ChatFacts extends GatewayFacts {
  /** Which protocol the client spoke. Read by the stages that must know — a vendor
   *  normalizer genuinely does — rather than reached for through an ambient field.
   *
   *  This is what `ctx.targetApi` was, read through `needs` rather than reached for. A stage
   *  that must not run on a request which re-entered its protocol still says so itself, by
   *  needing this key. What changed is that the thing it tests is declared. */
  'ingress.chat.sourceProtocol': ChatSourceProtocol;
  /** What the client asked for, per protocol and disjoint, because a translated request
   *  must not inherit the target protocol's answer to a question the client never asked. */
  'ingress.chat.chatCompletions.wantsStream': boolean;
  'ingress.chat.messages.wantsStream': boolean;
  'ingress.chat.responses.wantsStream': boolean;
  'ingress.chat.gemini.wantsStream': boolean;
  /** Whether the client wants the usage chunk it would otherwise never see. The gateway
   *  always asks the upstream for one; this decides who is shown it. */
  'ingress.chat.chatCompletions.wantsUsageChunk': boolean;

  /** One key per protocol. A translation consumes one and provides another, which is the
   *  whole of what a protocol handoff is. */
  'request.chat.chatCompletions': ChatCompletionsPayload;
  'request.chat.messages': MessagesPayload;
  'request.chat.responses': ResponsesPayload;
  'request.chat.gemini': GeminiPayload;

  /** A stream, a value and a failure sit at one key, so telling them apart is reading a
   *  value and no declaration ever mentions which arm is there. */
  'response.chat.chatCompletions': ChatAnswer;
  'response.chat.messages': ChatAnswer;
  'response.chat.responses': ChatAnswer;
  'response.chat.gemini': ChatAnswer;
}

/** What comes back at a protocol's response key. The frame type is the protocol's own; the
 *  three arms are the same shape for every protocol, which is why no stage dispatches on
 *  the arm in its declaration. */
export type ChatAnswer =
  | { readonly kind: 'stream'; readonly frames: AsyncIterable<unknown> }
  | { readonly kind: 'value'; readonly body: unknown }
  | Failure;

export type Chat<K extends keyof ChatFacts> = { [P in K]: ChatFacts[P] };
