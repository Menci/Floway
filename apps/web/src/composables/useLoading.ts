import { ref, type Ref } from 'vue';

// Wrap one or more async fns so a shared loading flag flips while any of them
// runs. Mirrors Marina's useLoading: callers get back the same fns but the
// returned ref reflects "anything in flight". The reactive flag survives
// concurrent calls because we count, not toggle.
export function useLoading<Fn extends (...args: never[]) => Promise<unknown>>(
  fn: Fn,
): [Ref<boolean>, Fn];
export function useLoading<Fns extends Array<(...args: never[]) => Promise<unknown>>>(
  loading: Ref<boolean>,
  ...fns: Fns
): Fns;
export function useLoading(...args: unknown[]): unknown {
  const first = args[0];
  const shared = isRef(first) ? (first as Ref<boolean>) : ref(false);
  const fns = (isRef(first) ? args.slice(1) : args) as Array<(...inner: never[]) => Promise<unknown>>;

  let inFlight = 0;
  const wrapped = fns.map(fn => async (...inner: never[]) => {
    inFlight++;
    shared.value = true;
    try {
      return await fn(...inner);
    } finally {
      inFlight--;
      if (inFlight === 0) shared.value = false;
    }
  });

  if (isRef(first)) return wrapped;
  return [shared, wrapped[0]];
}

const isRef = (v: unknown): v is Ref<unknown> =>
  v !== null && typeof v === 'object' && '__v_isRef' in v && (v as { __v_isRef: unknown }).__v_isRef === true;
