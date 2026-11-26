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
export const isAbortError = (err: unknown): boolean => {
  for (let cur: unknown = err; cur != null; cur = (cur as { cause?: unknown }).cause) {
    if (cur instanceof DOMException && cur.name === 'AbortError') return true;
    if (cur instanceof Error && cur.name === 'AbortError') return true;
  }
  return false;
};
