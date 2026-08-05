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
const MAX_CAUSE_DEPTH = 128;

export const isAbortError = (err: unknown): boolean => {
  const seen = new Set<object>();
  let cur = err;
  for (let depth = 0; cur !== null && cur !== undefined && depth < MAX_CAUSE_DEPTH; depth++) {
    if ((typeof cur !== 'object' && typeof cur !== 'function') || seen.has(cur)) return false;
    seen.add(cur);
    const candidate = cur as { cause?: unknown; name?: unknown };
    if (candidate.name === 'AbortError') return true;
    cur = candidate.cause;
  }
  return false;
};
