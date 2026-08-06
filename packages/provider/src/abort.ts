// Detect AbortError variants across runtimes so a propagated cancellation
// short-circuits the calling control flow rather than walking a backoff
// loop with an already-aborted signal.
//
// AbortError can land as a `DOMException { name: 'AbortError' }` (the
// modern Web Streams / fetch / browser shape) or, when the caller manually
// wraps it, any object whose `name === 'AbortError'`. Some runtimes —
// notably Cloudflare Workers and undici — further wrap aborts as
// `TypeError` with `{ cause: AbortError }`, so we walk the cause chain
// before deciding it's not an abort.
const readErrorProperty = (value: object, property: 'cause' | 'name'): unknown => {
  try {
    return Reflect.get(value, property);
  } catch {
    return undefined;
  }
};

export const isAbortError = (err: unknown): boolean => {
  const seen = new Set<object>();
  let cur = err;
  while (cur !== null && cur !== undefined) {
    if (typeof cur !== 'object' && typeof cur !== 'function') return false;
    if (seen.has(cur)) return false;
    seen.add(cur);
    if (readErrorProperty(cur, 'name') === 'AbortError') return true;
    cur = readErrorProperty(cur, 'cause');
  }
  return false;
};
