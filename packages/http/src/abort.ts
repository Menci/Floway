// Reshape an already-aborted signal into a throwable Error. A structured
// Error reason rethrows as-is so its stack/cause survive; a primitive or
// absent reason becomes a DOMException('AbortError').
export const signalAbortReason = (signal: AbortSignal): Error => {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  return new DOMException(String(reason ?? 'aborted'), 'AbortError');
};

export const isCausedBy = (cause: unknown, reason: unknown): boolean => {
  if (reason === undefined) return false;
  const seen = new Set<Error>();
  while (cause instanceof Error && !seen.has(cause)) {
    if (cause === reason) return true;
    seen.add(cause);
    cause = cause.cause;
  }
  return cause === reason;
};
