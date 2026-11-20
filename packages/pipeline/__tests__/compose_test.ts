import { describe, expect, it } from 'vitest';

import { attemptPipeline, cache, callUpstream, handoff, makeProvider, splitWords } from './fixtures.ts';
import type { Core } from './fixtures.ts';
import { compose, defineStage } from '../src/index.ts';

const provider = () => makeProvider('tok', []);

describe('compose', () => {
  it('derives the entry contract from what nobody below provides', () => {
    const serve = compose<Core<'in.text'>, Core<'out.result'>>('serve', [
      cache({}), splitWords, handoff(attemptPipeline(provider(), ['steady'])),
    ]);
    expect(serve.entryNeeds).toEqual(['in.text']);
  });

  it('leaves a key out of the entry contract once a stage above provides it', () => {
    const attempt = attemptPipeline(provider(), ['steady']);
    expect(attempt.entryNeeds).toEqual(['in.words']);   // `route.candidate` is failover's own
  });

  // The load-bearing one: a key an earlier stage consumed cannot be needed below it, so a
  // translated request cannot re-enter its own chain.
  it('refuses a stage that needs a key an earlier stage consumed', () => {
    expect(() => compose('reentry', [splitWords, cache({}), callUpstream(provider())]))
      .toThrow('compose(reentry): cache needs in.text, which splitWords consumed above it');
  });

  it('refuses a stage that declares `into` and is not last', () => {
    expect(() => compose('bad', [handoff(attemptPipeline(provider(), ['steady'])), splitWords]))
      .toThrow("compose(bad): handoff declares 'into' but is not last");
  });

  it('refuses a short-circuit that does not cover what the stages above it need', () => {
    const answersNothing = defineStage<Core<'in.words'>, object>({
      name: 'answersNothing',
      return: { provides: [] },
      execute: async facts => facts,
    });
    expect(() => compose('shortfall', [splitWords, answersNothing]))
      .toThrow('compose(shortfall): answersNothing may answer here, but its short-circuit does not provide out.result, which stages above it need');
  });

  it('refuses a stage that can neither answer nor descend', () => {
    const inert = { name: 'inert', execute: async () => ({}) };
    expect(() => compose('inert', [inert]))
      .toThrow('compose(inert): inert declares neither a way down nor a way to answer');
  });

  // The mirror of the re-entry error, on the way back: a stage that takes a response key
  // and does not hand it on leaves a stage above it needing something that cannot arrive.
  it('refuses a stage that consumes a response key a stage above it needs', () => {
    const swallows = defineStage<Core<'in.words'>, Core<'in.words'>, Core<'out.result'>, object>({
      name: 'swallows',
      through: {
        request: { needs: ['in.words'], consumes: [], provides: [] },
        response: { needs: ['out.result'], consumes: ['out.result'], provides: [] },
      },
      execute: async (facts, next) => await next(facts),
    });
    expect(() => compose('swallowed', [splitWords, swallows, callUpstream(provider())]))
      .toThrow('compose(swallowed): swallows consumes out.result on the way up, which a stage above it needs');
  });

  // A last stage that only declares `through` must go down, and there is nothing below it.
  it('refuses a pipeline whose last stage can only descend', () => {
    expect(() => compose('endless', [splitWords]))
      .toThrow('compose(endless): splitWords is last but can neither answer nor hand off');
  });

  // A stage that can only answer is where the array ends: anything after it never runs,
  // and deriving an entry contract from stages that never run would be worse than useless.
  it('refuses a stage that can only answer with stages written after it', () => {
    expect(() => compose('unreachable', [callUpstream(provider()), splitWords]))
      .toThrow('compose(unreachable): callUpstream can only answer, so the stages after it never run');
  });

  // Assembly reasons over declarations, which are strings, so a stage written against a
  // provider's larger space composes beside stages written against the core space with no
  // variance question to lose. This is the composition the architecture exists to make work.
  it('composes stages from two different fact spaces', () => {
    expect(() => compose('mixed', [splitWords, handoff(attemptPipeline(provider(), ['steady']))])).not.toThrow();
  });
});
