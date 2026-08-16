// A protocol handoff, as a stage.
//
// This is the whole of what a translation is in the fact space: it **consumes** the source
// protocol's request key and **provides** the target's, and coming back it consumes the
// target's response key and provides the source's. Two consequences follow from saying it
// that way rather than carrying a `targetApi` field.
//
// A chain cannot re-enter its own protocol. The source key is gone below this stage, so a
// stage that needs it cannot be placed there and `compose` says so at assembly — which is
// `ctx.targetApi === <self>` deleted and made structural rather than tested at runtime.
//
// And nothing below knows a translation happened. The target chain sees its own protocol's
// keys and only those, so the same chain serves a native request and a translated one.

import type { ChatAnswer, ChatFacts } from './facts.ts';
import { isFailure } from '../pipeline/facts.ts';
import { defineStage, move } from '@floway-dev/pipeline';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { TranslateTripResult } from '@floway-dev/translate';

type RequestKey = Extract<keyof ChatFacts, `request.chat.${string}`>;
type ResponseKey = Extract<keyof ChatFacts, `response.chat.${string}`>;

export interface Handoff<Source extends RequestKey, Target extends RequestKey> {
  /** The two request keys, and the two response keys they answer at. Naming all four is what
   *  lets the declaration be written; a pair is not derivable from one half. */
  readonly from: { readonly request: Source; readonly response: ResponseKey };
  readonly to: { readonly request: Target; readonly response: ResponseKey };
  /** The pair function, already closed over whatever context it reads. It returns the target
   *  payload together with the closure that maps the target's frames back — trip-scoped
   *  state (synthetic ids, custom-tool name sets) lives in that closure and the source chain
   *  never sees it. */
  readonly trip: (source: ChatFacts[Source]) => Promise<TranslateTripResult<ChatFacts[Target], unknown, unknown>>;
}

/**
 * Translates on the way down and back on the way up.
 *
 * An upstream refusal gets the pair's own rewrite where it has one: the canonical case is a
 * context-window error becoming the Anthropic `prompt is too long:` shape that Claude Code
 * reads for auto-compaction. A pair that declares no rewrite hands the refusal up unchanged.
 */
export const handOff = <Source extends RequestKey, Target extends RequestKey>(
  handoff: Handoff<Source, Target>,
) => defineStage<
  { [K in Source]: ChatFacts[Source] },
  { [K in Target]: ChatFacts[Target] },
  { [K in ResponseKey]?: ChatAnswer } & Record<string, unknown>,
  { [K in ResponseKey]?: ChatAnswer } & Record<string, unknown>
>({
  name: `handOff:${handoff.from.request}→${handoff.to.request}`,
  through: {
    request: {
      needs: [handoff.from.request],
      consumes: [handoff.from.request],
      provides: [handoff.to.request],
    },
    response: {
      // The upstream's own headers are read, not rewritten: a pair that rewrites a refusal
      // is handed what actually came back rather than a synthesized set.
      needs: [handoff.to.response, 'response.http.headers'],
      consumes: [handoff.to.response],
      provides: [handoff.from.response],
    },
  },
  execute: async (facts, next) => {
    const record = facts as Record<string, unknown>;
    const { [handoff.from.request]: source, ...down } = record;
    const trip = await handoff.trip(source as ChatFacts[Source]);

    const back = await next({ ...down, [handoff.to.request]: move(trip.target) } as never) as Record<string, unknown>;
    const { [handoff.to.response]: answered, ...up } = back;
    const answer = answered as ChatAnswer;

    if (isFailure(answer)) {
      // The pair works on the upstream's own bytes, which is what `message` holds: a refusal
      // is read as text and parsed only for whoever wants the object.
      const rewritten = trip.apiError?.({
        status: answer.status,
        headers: new Headers(((up['response.http.headers'] ?? []) as readonly (readonly [string, string])[]).map(([name, value]): [string, string] => [name, value])),
        body: new TextEncoder().encode(answer.message),
      });
      if (rewritten === undefined) return { ...up, [handoff.from.response]: answer } as never;
      const text = new TextDecoder().decode(rewritten.body);
      let parsed: unknown;
      try { parsed = JSON.parse(text) as unknown; } catch { parsed = undefined; }
      return {
        ...up,
        [handoff.from.response]: move({
          status: rewritten.status,
          message: text,
          ...(parsed === undefined ? {} : { body: parsed }),
        }),
      } as never;
    }
    if (answer.kind === 'value') {
      // A pair maps frames and nothing else, so an answer that arrived as a value has no
      // mapping to cross the protocol boundary with. Handing it on would give the client
      // another protocol's object under its own key, so this fails rather than mistranslates.
      throw new Error(
        `${handoff.to.request} answered with a value, and no pair maps one into ${handoff.from.request}`,
      );
    }
    return {
      ...up,
      [handoff.from.response]: move({
        kind: 'stream',
        frames: trip.events(answer.frames as AsyncIterable<ProtocolFrame<unknown>>),
      }),
    } as never;
  },
});
