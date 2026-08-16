// A fact space with no business in it, and the stages that exercise every shape. Kept
// beside the tests because it is what the tests are about: the core has to work for a
// space it has never heard of.

import { compose, defineStage, move, transform } from '../src/index.ts';
import type { Pipeline, Slice } from '../src/index.ts';

export interface CoreFacts {
  'in.text': string;
  'in.words': readonly string[];
  'route.candidate': string;
  /** Failure is a value. The declaration names this key; which arm is in it is a property
   *  of the value, not something a stage declares. */
  'out.result': { readonly ok: string } | { readonly failed: string };
  'out.body': AsyncDisposable & { readonly label: string };
}

/** A provider extends the space with its own keys; it never merges into the core. */
export interface ProviderFacts extends CoreFacts {
  'provider.token': string;
}

export type Core<K extends keyof CoreFacts> = Slice<CoreFacts, K>;

/** A provider package. `ProviderFacts` is defined here and never leaves: the handle's
 *  type mentions only the core space. */
export interface SealedHandle {
  readonly name: string;
  readonly enter: (facts: Core<'in.words' | 'route.candidate'>) => Promise<Core<'out.result' | 'out.body'>>;
}

export const makeProvider = (token: string, released: string[]): SealedHandle => {
  const inside: Slice<ProviderFacts, 'provider.token'> = move({ 'provider.token': token });
  return {
    name: 'toy-provider',
    enter: async facts => {
      const candidate = facts['route.candidate'];
      // Every attempt opens a body, the failing one included — which is why a losing
      // branch has something to release.
      return move({
        'out.result': candidate === 'flaky'
          ? { failed: `${candidate} refused` }
          : { ok: `${inside['provider.token']}:${facts['in.words'].join('-')}` },
        'out.body': { label: candidate, [Symbol.asyncDispose]: async () => { released.push(`body@${candidate}`); } },
      });
    },
  };
};

/** (1) return — it answers, and may not call next. Its `execute` takes one argument. */
export const callUpstream = (handle: SealedHandle) =>
  defineStage<Core<'in.words' | 'route.candidate'>, Core<'out.result' | 'out.body'>>({
    name: 'callUpstream',
    return: { provides: ['out.result', 'out.body'] },
    // Answering hands up the whole record too, so the keys that reached the ending are
    // still accounted for on the way back.
    execute: async facts => move({ ...facts, ...(await handle.enter(facts)) }),
  });

/** (2) through + return — a cache: it answers on a hit and goes down on a miss. This is
 *  the shape a single `kind` discriminator cannot express. */
export const cache = (canned: Record<string, string>) =>
  defineStage<Core<'in.text'>, Core<'in.text'>, Core<'out.result'>, Core<'out.result'>>({
    name: 'cache',
    through: {
      request: { needs: ['in.text'], consumes: [], provides: [] },
      response: { needs: ['out.result'], consumes: [], provides: [] },
    },
    return: { provides: ['out.result'] },
    execute: async (facts, next) => {
      const hit = canned[facts['in.text']];
      if (hit !== undefined) return move({ ...facts, 'out.result': { ok: hit } });
      return await next(facts);
    },
  });

/** (3) through — it must go down. Creating and modifying are one return, and removing is
 *  the same action written the other way. */
export const splitWords = defineStage<Core<'in.text'>, Core<'in.words'>, Core<'out.result'>, Core<'out.result'>>({
  name: 'splitWords',
  through: {
    request: { needs: ['in.text'], consumes: ['in.text'], provides: ['in.words'] },
    response: { needs: ['out.result'], consumes: [], provides: [] },
  },
  execute: transform(() => ({
    request: facts => {
      const { 'in.text': text, ...rest } = facts;
      return { ...rest, 'in.words': move(text.split(' ')) };
    },
  })),
});

/** (3 again) An ordinary `through` stage that happens to call next more than once.
 *  Nothing in the framework knows what a retry is. */
export const failover = (candidates: readonly string[]) =>
  defineStage<
    Core<'in.words'>,
    Core<'in.words' | 'route.candidate'>,
    Core<'out.result' | 'out.body'>,
    Core<'out.result' | 'out.body'>
  >({
    name: 'failover',
    through: {
      request: { needs: ['in.words'], consumes: [], provides: ['route.candidate'] },
      // It owns every attempt's body — that is `consumes` — and hands the winner's
      // onward, which is `provides`. Ownership of that one goes with it.
      response: { needs: ['out.result'], consumes: ['out.body'], provides: ['out.body'] },
    },
    execute: async (facts, next) => {
      let last: Core<'out.result' | 'out.body'> | undefined;
      for (const candidate of candidates) {
        last = await next({ ...facts, 'route.candidate': candidate });
        if ('ok' in last['out.result']) return last;  // failure is a value, not a throw
      }
      if (last === undefined) throw new Error('failover: no candidates');
      return last;
    },
  });

/** The closure earning its keep: state computed on the way down and used on the way up.
 *  It cannot live in a fact (it is not one) or on the stage (shared across runs). */
export const rememberShape = defineStage<Core<'in.words'>, Core<'in.words'>, Core<'out.result'>, Core<'out.result'>>({
  name: 'rememberShape',
  through: {
    request: { needs: ['in.words'], consumes: [], provides: [] },
    response: { needs: ['out.result'], consumes: [], provides: [] },
  },
  execute: transform(() => {
    let wordCount = 0;                                      // per invocation, both directions
    return {
      request: facts => { wordCount = facts['in.words'].length; return facts; },
      response: facts => {
        const result = facts['out.result'];
        if (!('ok' in result)) return facts;                // hand up what came back
        return { ...facts, 'out.result': move({ ok: `${result.ok} (${wordCount}w)` }) };
      },
    };
  }),
});

type AttemptPipeline = Pipeline<Core<'in.words'>, Core<'out.result'>>;

/** (4) into + return — hands off to a named pipeline, unless there is nothing to do. */
export const handoffUnlessEmpty = (target: AttemptPipeline) =>
  defineStage<Core<'in.words'>, Core<'in.words'>, Core<'out.result'>, Core<'out.result'>>({
    name: 'handoffUnlessEmpty',
    into: {
      request: { needs: ['in.words'], consumes: [], provides: [] },
      response: { needs: ['out.result'], consumes: [], provides: [] },
    },
    return: { provides: ['out.result'] },
    execute: async (facts, next) => (facts['in.words'].length === 0
      ? move({ ...facts, 'out.result': { ok: '' } })
      : await next(facts, target)),
  });

/** (5) into — it must hand off. `next` takes the target; a `through` stage's does not. */
export const handoff = (target: AttemptPipeline) =>
  defineStage<Core<'in.words'>, Core<'in.words'>, Core<'out.result'>, Core<'out.result'>>({
    name: 'handoff',
    into: {
      request: { needs: ['in.words'], consumes: [], provides: [] },
      response: { needs: ['out.result'], consumes: [], provides: [] },
    },
    execute: async (facts, next) => await next(facts, target),
  });

export const attemptPipeline = (handle: SealedHandle, candidates: readonly string[]): AttemptPipeline =>
  compose<Core<'in.words'>, Core<'out.result'>>('attempt', [failover(candidates), callUpstream(handle)]);

export const servePipeline = (attempt: AttemptPipeline, canned: Record<string, string> = {}) =>
  compose<Core<'in.text'>, Core<'out.result'>>('serve', [cache(canned), splitWords, rememberShape, handoff(attempt)]);
