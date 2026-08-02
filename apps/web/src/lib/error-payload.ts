// The gateway's failure body, and the same shape relayed from a data-plane
// upstream: `{ error: "..." }` or `{ error: { message: "..." } }`. Distinct from
// `errorMessage`, which narrows a thrown value rather than a decoded payload.
export const errorMessageFromPayload = (payload: unknown): string | null => {
  if (!payload || typeof payload !== 'object') return null;

  const error = (payload as { error?: unknown }).error;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') {
    return (error as { message: string }).message;
  }

  return null;
};
