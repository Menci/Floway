// Reshape an already-aborted signal into a throwable Error. A structured
// Error reason rethrows as-is so its stack/cause survive; a primitive or
// absent reason becomes a DOMException('AbortError').
export const signalAbortReason = (signal: AbortSignal): Error => {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  return new DOMException(String(reason ?? 'aborted'), 'AbortError');
};

export const isCausedBy = (error: unknown, reason: unknown): boolean => {
  if (reason === undefined) return false;
  const seen = new Set<Error>();
  while (error instanceof Error && error !== reason && !seen.has(error)) {
    seen.add(error);
    error = error.cause;
  }
  return error === reason;
};

class HttpAbortReason extends Error {
  constructor(cause: unknown) {
    super(`HTTP request aborted (${crypto.randomUUID()})`, { cause });
  }
}

export const bindHttpAbort = (parent: AbortSignal) => {
  const controller = new AbortController();
  const abort = () => controller.abort(new HttpAbortReason(parent.reason));
  parent.addEventListener('abort', abort, { once: true });
  if (parent.aborted) abort();
  return { signal: controller.signal, release: () => parent.removeEventListener('abort', abort) };
};

export const restoreRematerializedHttpAbort = (cause: unknown, signal: AbortSignal | null | undefined): Error | undefined => {
  const reason = signal?.reason;
  // Workerd transfers native fetch errors by name and message, losing Error.cause and identity.
  // https://github.com/cloudflare/workerd/issues/7035
  // The privately generated operation token distinguishes that copy from unrelated failures.
  if (reason instanceof HttpAbortReason && cause instanceof Error && cause.name === reason.name && cause.message === reason.message) {
    return reason;
  }
};
