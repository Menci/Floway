export const errorMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

// An aborted request is the caller's own decision, so its DOMException text
// ("signal is aborted without reason") is never operator copy.
export const isAbortError = (cause: unknown): boolean => cause instanceof Error && cause.name === 'AbortError';
