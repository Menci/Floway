import { afterEach, beforeEach } from 'vitest';

// happy-dom answers every media query with `matches: false`, so a suite that
// needs another answer installs its own `matchMedia`. Restoring it is the whole
// point of doing that here: Fluent's reduced-motion hook latches the first
// answer it is given, so a stub left behind decides the motion of every suite
// that runs after it.
//
// The returned setter re-points the answer, for a suite that renders the same
// tree under two different queries.
export const stubMatchMedia = (matches: (query: string) => boolean): ((next: (query: string) => boolean) => void) => {
  let answer = matches;
  const original = Object.getOwnPropertyDescriptor(window, 'matchMedia');

  beforeEach(() => {
    answer = matches;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (query: string): MediaQueryList => ({
        addEventListener: () => {},
        addListener: () => {},
        dispatchEvent: () => false,
        matches: answer(query),
        media: query,
        onchange: null,
        removeEventListener: () => {},
        removeListener: () => {},
      }),
    });
  });

  afterEach(() => {
    if (original) Object.defineProperty(window, 'matchMedia', original);
    else Reflect.deleteProperty(window, 'matchMedia');
  });

  return next => { answer = next; };
};
