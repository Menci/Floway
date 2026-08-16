// Two assertions the compiler holds, checked by compiling. `@ts-expect-error` fails the
// build when the error it names does *not* occur, so these are real tests that happen to
// run at typecheck time rather than at vitest time.

import { describe, expect, it } from 'vitest';

import type { CoreFacts } from './fixtures.ts';
import { decodeKey, defineStage, encodeKey } from '../src/index.ts';
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

// The two `@ts-expect-error` markers above are the assertions: each fails the build if the
// error it names stops occurring. What is left for runtime is the reader's half of the key
// escaping, which has no compile-time form.
describe('what the type layer holds', () => {
  it('round-trips a key that begins with a dollar', () => {
    for (const key of ['$ref', '$defs', '$schema', 'model', '$$literal']) {
      expect(decodeKey(encodeKey(key))).toBe(key);
    }
    expect(encodeKey('$ref')).toBe('$$ref');
    expect(decodeKey('$$ref')).toBe('$ref');
  });
});
