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

const readErrorCause = (value: object): { dynamic: boolean; value: unknown } => {
  try {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, 'cause');
    if (descriptor && 'value' in descriptor) return { dynamic: false, value: descriptor.value };
  } catch {
    return { dynamic: true, value: undefined };
  }
  return { dynamic: true, value: readErrorProperty(value, 'cause') };
};

// Ordinary Error causes are own data properties, so finite stored chains have
// no artificial depth boundary. Only accessors or inherited/dynamic causes
// spend this budget; they can manufacture a fresh object on every read.
const MAX_DYNAMIC_ABORT_CAUSE_READS = 4096;

export const isAbortError = (err: unknown): boolean => {
  const seen = new WeakSet<object>();
  let cur = err;
  let dynamicCauseReads = 0;
  while (cur !== null && cur !== undefined) {
    if (typeof cur !== 'object' && typeof cur !== 'function') return false;
    if (seen.has(cur)) return false;
    seen.add(cur);
    if (readErrorProperty(cur, 'name') === 'AbortError') return true;
    const cause = readErrorCause(cur);
    if (cause.dynamic && ++dynamicCauseReads >= MAX_DYNAMIC_ABORT_CAUSE_READS) return false;
    cur = cause.value;
  }
  return false;
};
