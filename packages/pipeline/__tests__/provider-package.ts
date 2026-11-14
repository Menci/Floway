// A provider package, standing on its own. It extends the fact space with a key of its
// own, that key *travels* — created by one of its stages and consumed by another before
// the request leaves — and nothing outside this module can name it.
//
// What it exports is a sealed handle: a `Pipeline` whose type mentions only the core
// space. That is the whole cross-package handoff question, and what answers it is
// `compose` taking erased stages, so a pipeline's interior never enters its type. The
// module boundary changes nothing, because the erasure happens at assembly and not at the
// import.

import type { CoreFacts } from './fixtures.ts';
import { compose, defineStage, move, own, transform } from '../src/index.ts';
import type { Pipeline, Slice } from '../src/index.ts';

/** Defined here and never exported. A stage written against the core space cannot name it,
 *  and the compiler says so at the definition site. */
interface ProviderFacts extends CoreFacts {
  'provider.token': string;
}

type P<K extends keyof ProviderFacts> = Slice<ProviderFacts, K>;
type C<K extends keyof CoreFacts> = Slice<CoreFacts, K>;

/** Mints the credential. It is a fact, so it is in the record and in the dump — and it is
 *  gone again before the request leaves this subtree. */
const attachToken = defineStage<
  C<'route.candidate'>,
  P<'provider.token'>,
  C<'out.result' | 'out.body'>,
  C<'out.result' | 'out.body'>
>({
  name: 'attachToken',
  through: {
    request: { needs: ['route.candidate'], consumes: [], provides: ['provider.token'] },
    response: { needs: ['out.result'], consumes: [], provides: [] },
  },
  execute: transform(() => ({
    request: facts => ({ ...facts, 'provider.token': `tok-${facts['route.candidate']}` }),
  })),
});

/** Spends it and drops it, so nothing below this point can reach the credential. */
const callWithToken = defineStage<
  P<'provider.token'> & C<'in.words' | 'route.candidate'>,
  C<'out.result' | 'out.body'>
>({
  name: 'callWithToken',
  return: { provides: ['out.result', 'out.body'] },
  execute: async facts => {
    const { 'provider.token': token, ...rest } = facts;
    const candidate = facts['route.candidate'];
    return move({
      ...rest,
      'out.result': candidate === 'flaky'
        ? { failed: `${candidate} refused` }
        : { ok: `${token}:${facts['in.words'].join('-')}` },
      'out.body': own({ label: candidate }, async () => {}),
    });
  },
});

/**
 * The seal. Its type mentions only core keys; `provider.token` appears nowhere in it, and
 * a caller cannot learn that the key exists — let alone name it.
 */
export const providerChain: Pipeline<
  C<'in.words' | 'route.candidate'>,
  C<'out.result' | 'out.body'>
> = compose('toy-provider', [attachToken, callWithToken]);
