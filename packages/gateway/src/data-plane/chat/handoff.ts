import type { ChatFacts, ChatAnswer } from './facts.ts';
import type { RequestKey } from './wire.ts';
import { isFailure } from '../pipeline/facts.ts';
import { defineStage, move } from '@floway-dev/pipeline';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import { TranslatorInputError, type TranslateTripResult } from '@floway-dev/translate';

type ResponseKey = Extract<keyof ChatFacts, `response.chat.${string}`>;

export interface Handoff<Source extends RequestKey, Target extends RequestKey, TargetEvent> {
  /** The two request keys, and the two response keys they answer at. Naming all four is what
   *  lets the declaration be written; a pair is not derivable from one half. */
  readonly from: { readonly request: Source; readonly response: ResponseKey };
  readonly to: { readonly request: Target; readonly response: ResponseKey };
  /** The pair function, already closed over whatever context it reads. It returns the target
   *  payload together with the closure that maps the target's frames back — trip-scoped
   *  state (synthetic ids, custom-tool name sets) lives in that closure and the source chain
   *  never sees it.
   *
   *  Only the *target's* event type is named. It is what the pair's mapping closure is handed,
   *  so leaving it open would make the frames coming off the wire unassignable to it; what the
   *  closure produces goes straight to the source's response key, which no declaration here
   *  looks inside. */
  readonly trip: (source: ChatFacts[Source]) => Promise<TranslateTripResult<ChatFacts[Target], unknown, TargetEvent>>;
}

/**
 * What a source chain holds when the translation itself refused.
 *
 * The four keys are what "no upstream was called" looks like on this family's slice: nothing
 * billed, no upstream headers to carry, and nothing still streaming for settlement to wait on.
 * The streamed-usage key is the response key's own sub-key by the fact space's naming rule, so
 * naming it here costs no call site a parameter. A family that broke the convention is caught by
 * the runner rather than by assembly: `handOff` is the first stage of every wire, so nothing
 * above it inside that composition needs the key, and it is `dialChatWire` — which declares the
 * whole set the wire owes — whose provides check fails when the wire hands up a key by another
 * name.
 *
 * No envelope is written. Each family renders a failure in its own protocol at its own edge,
 * which is the only place that knows what that protocol's clients read.
 */
const refuseTranslation = (response: ResponseKey, message: string): Record<string, unknown> => ({
  'response.usage.billable': [],
  'response.http.headers': [],
  [`${response}.streamedUsage`]: null,
  [response]: { status: 400, message },
});

/**
 * Translates on the way down and back on the way up.
 *
 * An upstream refusal gets the pair's own rewrite where it has one: the canonical case is a
 * context-window error becoming the Anthropic `prompt is too long:` shape that Claude Code
 * reads for auto-compaction. Where a pair declares no rewrite, the status and the sentence go up
 * and the object they arrived in does not — it is the target protocol's, and the client is not
 * reading that one.
 *
 * It carries the `return` trait too, because a body the target protocol cannot represent is
 * answered here rather than dialled.
 */
export const handOff = <Source extends RequestKey, Target extends RequestKey, TargetEvent>(
  handoff: Handoff<Source, Target, TargetEvent>,
) => defineStage<
  { [K in Source]: ChatFacts[Source] },
  { [K in Target]: ChatFacts[Target] },
  { [K in ResponseKey]?: ChatAnswer } & Record<string, unknown>,
  { [K in ResponseKey]?: ChatAnswer } & Record<string, unknown>
>({
  name: `handOff:${handoff.from.request}→${handoff.to.request}`,
  return: {
    provides: [
      handoff.from.response,
      `${handoff.from.response}.streamedUsage`,
      'response.usage.billable',
      'response.http.headers',
    ],
  },
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

    let trip;
    try {
      trip = await handoff.trip(source as ChatFacts[Source]);
    } catch (error) {
      // Input this target protocol cannot represent is the client's fault, and the translator
      // is what knows which part of the body was at fault. Answering rather than throwing is
      // also what keeps it a *candidate's* verdict: the same body may translate cleanly for
      // the next candidate, whose wire is a different protocol, and failover re-runs the
      // suffix to find out. Anything else raised down here is a fault of this gateway's and
      // rides up as one.
      if (!(error instanceof TranslatorInputError)) throw error;
      return move({ ...down, ...refuseTranslation(handoff.from.response, error.message) }) as never;
    }

    const back = await next({ ...down, [handoff.to.request]: move(trip.target) } as never) as Record<string, unknown>;
    const { [handoff.to.response]: answered, ...up } = back;
    const answer = answered as ChatAnswer;

    if (isFailure(answer)) {
      // The pair works on the upstream's own bytes, which is what `message` holds: a refusal
      // is read as text and parsed only for whoever wants the object.
      const rewritten = trip.apiError?.({
        status: answer.status,
        headers: new Headers((up['response.http.headers'] as readonly (readonly [string, string])[]).map(([name, value]): [string, string] => [name, value])),
        body: new TextEncoder().encode(answer.message),
      });
      // A pair that declares no rewrite has nothing that can carry the refusal across, so what
      // crosses is the status and the sentence and not the object they came in. The object is
      // the *target* protocol's envelope — an OpenAI `{error:{type,code}}` where the client is
      // reading Anthropic, or anything at all where the client is Gemini generateContent and reads
      // `error.status` — and handing it on would answer one protocol in another's words. The
      // family's own edge renders what is left, in the protocol its client actually speaks.
      //
      // Nothing is lost to the record: the target's failure was already written at the target's
      // own key, with its body, before this stage consumed it.
      if (rewritten === undefined) {
        const { body: _foreign, envelope: _foreignEnvelope, ...carried } = answer;
        return { ...up, [handoff.from.response]: move(carried) } as never;
      }
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
        frames: trip.events(answer.frames as AsyncIterable<ProtocolFrame<TargetEvent>>),
      }),
    } as never;
  },
});
