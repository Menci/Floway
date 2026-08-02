import { afterEach, beforeEach } from 'vitest';

// happy-dom ships no `localStorage`, so anything reaching `src/auth/session.ts`
// installs one. It has to be backed by real storage: a `getItem` that answers
// with a constant hides precisely the bug these suites exist to catch, where a
// token written by one code path is read back by another.
//
// The returned map is the backing store, so a suite that needs a seeded session
// can register its own `beforeEach` after this call and write into it.
export const stubLocalStorage = (): Map<string, string> => {
  const values = new Map<string, string>();
  const original = Object.getOwnPropertyDescriptor(window, 'localStorage');

  beforeEach(() => {
    values.clear();
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        clear: () => { values.clear(); },
        getItem: (key: string) => values.get(key) ?? null,
        key: (index: number) => [...values.keys()][index] ?? null,
        get length() { return values.size; },
        removeItem: (key: string) => { values.delete(key); },
        setItem: (key: string, value: string) => { values.set(key, value); },
      } satisfies Storage,
    });
  });

  afterEach(() => {
    if (original) Object.defineProperty(window, 'localStorage', original);
    else Reflect.deleteProperty(window, 'localStorage');
  });

  return values;
};
