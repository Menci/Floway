// Two assertions the compiler holds, checked by compiling. `@ts-expect-error` fails the
// build when the error it names does *not* occur, so these are real tests that happen to
// run at typecheck time rather than at vitest time.

import { describe, expect, it } from 'vitest';

import type { CoreFacts, ProviderFacts } from './fixtures.ts';
import { defineStage } from '../src/index.ts';
import type { Pipeline, Slice } from '../src/index.ts';

type Core<K extends keyof CoreFacts> = Slice<CoreFacts, K>;

// A `through` stage's `next` takes one argument, so naming a target is an error at the
// definition site — which is the one half of "into must be last" that a type can hold.
void defineStage<Core<'in.words'>, Core<'in.words'>, Core<'out.result'>, Core<'out.result'>>({
  name: 'throughCannotNameATarget',
  through: {
    request: { needs: ['in.words'], consumes: [], provides: [] },
    response: { needs: ['out.result'], consumes: [], provides: [] },
  },
  execute: async (facts, next) => await next(
    facts,
    // @ts-expect-error a `through` stage's next takes one argument
    null as unknown as Pipeline<Core<'in.words'>, Core<'out.result'>>,
  ),
});

// A provider's own key is unreachable from a pipeline over the gateway's space: the key is
// not in that space at all, so a stage written against it cannot name one.
declare const gatewayOnly: (stage: {
  readonly through?: { readonly request: { readonly needs: readonly (keyof CoreFacts)[] } };
}) => void;

const leakCheck = (): void => gatewayOnly({
  through: {
    // @ts-expect-error 'provider.token' is not a key of CoreFacts
    request: { needs: ['provider.token'] },
  },
});
void leakCheck;

// Named so the intent survives a reader who never runs `tsc` — and so the file is a test
// file by the repository's own convention rather than a stray module.
describe('what the type layer holds', () => {
  it('is checked by compiling, and the two @ts-expect-error markers above are the checks', () => {
    const providerKey: keyof ProviderFacts = 'provider.token';
    const coreKeys: readonly (keyof CoreFacts)[] = ['in.text', 'in.words', 'route.candidate', 'out.result', 'out.body'];
    expect(coreKeys).not.toContain(providerKey);
  });
});
