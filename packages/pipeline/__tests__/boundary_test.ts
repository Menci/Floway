// What a handoff must satisfy when the target pipeline lives in another package. It turns
// out to need nothing, and this is the proof — the provider is a separate module with its
// own fact space, its own key that travels through the record, and an export whose type
// mentions only the core space.

import { describe, expect, it } from 'vitest';

import { callUpstream, failover, makeProvider, splitWords } from './fixtures.ts';
import type { Core } from './fixtures.ts';
import { providerChain } from './provider-package.ts';
import { compose, defineStage, move, run } from '../src/index.ts';
import type { Event } from '../src/index.ts';

const PLAIN = {};

/** The gateway's side of the boundary. It names the target and knows nothing else about
 *  it — not its stages, not its space, not that it has one. */
const enterProvider = defineStage<
  Core<'in.words' | 'route.candidate'>,
  Core<'in.words' | 'route.candidate'>,
  Core<'out.result' | 'out.body'>,
  Core<'out.result' | 'out.body'>
>({
  name: 'enterProvider',
  into: {
    request: { needs: ['in.words', 'route.candidate'], consumes: [], provides: [] },
    response: { needs: ['out.result'], consumes: [], provides: [] },
  },
  execute: async (facts, next) => await next(facts, providerChain),
});

describe('a handoff across a package boundary', () => {
  it('enters a provider whose fact space the caller cannot see', async () => {
    const serve = compose<Core<'in.words' | 'route.candidate'>, Core<'out.result'>>('serve', [enterProvider]);
    const { facts } = await run(serve, move({ 'in.words': ['a', 'b'], 'route.candidate': 'steady' }), PLAIN);
    expect(facts['out.result']).toEqual({ ok: 'tok-steady:a-b' });
  });

  // A pipeline's interior is not part of its type — that is what `compose` erasing its
  // stages buys — so the module boundary changes nothing that assembly had not already
  // settled. The credential is a fact the whole way, and the dump shows it.
  it('carries the provider-s own key through the record and drops it before the wire', async () => {
    const seen: Event[] = [];
    const serve = compose<Core<'in.words' | 'route.candidate'>, Core<'out.result'>>('serve', [enterProvider]);
    await run(serve, move({ 'in.words': ['a'], 'route.candidate': 'steady' }), { dump: (e: Event) => { seen.push(e); } });

    const carrying = seen.filter(e => e.type === 'stage.entered' && 'provider.token' in e.facts);
    expect(carrying.map(e => e.type === 'stage.entered' ? e.name : '')).toEqual(['callWithToken']);

    // And it is gone from what the run answers with.
    const last = seen.filter(e => e.type === 'stage.leaved').at(-1)!;
    expect('provider.token' in last.facts).toBe(false);
  });

  it('fails over across the boundary, because the fork is above it', async () => {
    const serve = compose<Core<'in.text'>, Core<'out.result'>>('serve', [
      splitWords, failover(['flaky', 'steady']), enterProvider,
    ]);
    const { facts } = await run(serve, move({ 'in.text': 'a b' }), PLAIN);
    expect(facts['out.result']).toEqual({ ok: 'tok-steady:a-b' });
  });

  // Two providers with different spaces, in one composition, reached through one type.
  it('holds two providers whose spaces differ behind one seal type', async () => {
    const other = compose<Core<'in.words' | 'route.candidate'>, Core<'out.result' | 'out.body'>>(
      'other-provider', [callUpstream(makeProvider('other', []))],
    );
    const choose = defineStage<
      Core<'in.words' | 'route.candidate'>,
      Core<'in.words' | 'route.candidate'>,
      Core<'out.result' | 'out.body'>,
      Core<'out.result' | 'out.body'>
    >({
      name: 'choose',
      into: {
        request: { needs: ['in.words', 'route.candidate'], consumes: [], provides: [] },
        response: { needs: ['out.result'], consumes: [], provides: [] },
      },
      execute: async (facts, next) =>
        await next(facts, facts['route.candidate'] === 'steady' ? providerChain : other),
    });
    const serve = compose<Core<'in.words' | 'route.candidate'>, Core<'out.result'>>('serve', [choose]);

    expect((await run(serve, move({ 'in.words': ['a'], 'route.candidate': 'steady' }), PLAIN)).facts['out.result'])
      .toEqual({ ok: 'tok-steady:a' });
    expect((await run(serve, move({ 'in.words': ['a'], 'route.candidate': 'quiet' }), PLAIN)).facts['out.result'])
      .toEqual({ ok: 'other:a' });
  });
});
