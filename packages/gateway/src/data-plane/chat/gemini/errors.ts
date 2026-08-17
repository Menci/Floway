// Google RPC Status envelope, used by Gemini's `error` channel everywhere
// (HTTP body, SSE-tunnelled error event).
/** What a Gemini client is sent when a turn produced no content. `error.status` is the
 *  Google-RPC name and clients read it, so this shape is the protocol's rather than the
 *  gateway's — an OpenAI-shaped envelope would leave that field undefined. */
export const renderGeminiError = (status: number, message: string): Record<string, unknown> => ({
  error: { code: status, message, status: geminiStatusForHttpStatus(status) },
});

export const geminiStatusForHttpStatus = (status: number): string => {
  switch (status) {
  case 400:
    return 'INVALID_ARGUMENT';
  case 401:
    return 'UNAUTHENTICATED';
  case 403:
    return 'PERMISSION_DENIED';
  case 404:
    return 'NOT_FOUND';
  case 429:
    return 'RESOURCE_EXHAUSTED';
  case 500:
    return 'INTERNAL';
  case 502:
  case 503:
    return 'UNAVAILABLE';
  default:
    return 'INTERNAL';
  }
};
