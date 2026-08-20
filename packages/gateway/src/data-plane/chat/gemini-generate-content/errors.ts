// Google RPC Status envelope, used by Gemini's `error` channel everywhere
// (HTTP body, SSE-tunnelled error event).

/**
 * What a Gemini generateContent client is sent when this gateway is the one refusing: the
 * envelope, and the status it is sent with.
 *
 * `error.status` is the Google-RPC name and clients read it, so the shape is the protocol's
 * rather than the gateway's — an OpenAI-shaped envelope would leave that field undefined.
 *
 * The two are decided together because the envelope states its code as well as naming it, and
 * this protocol has a name for only nine codes: everything else is `INTERNAL`, which belongs
 * to 500 alone. Minting from some other status would say two different things about one
 * failure — `code: 418` beside `status: "INTERNAL"`, sent as a 418 — so a status this protocol
 * cannot name is sent as the one that name belongs to. Deciding them apart is what let that
 * disagreement exist, which is why nothing here renders an envelope without also saying what
 * to send it with.
 *
 * A forwarded upstream body and a refusal's own envelope keep their status untouched: they
 * already say what they mean, and neither is this gateway's to reword.
 */
export const mintGeminiGenerateContentFailure = (failure: { readonly status: number; readonly message: string }): {
  readonly body: Record<string, unknown>;
  readonly status: number;
} => {
  const status = geminiGenerateContentStatusForHttpStatus(failure.status) === 'INTERNAL' ? 500 : failure.status;
  return {
    body: { error: { code: status, message: failure.message, status: geminiGenerateContentStatusForHttpStatus(status) } },
    status,
  };
};

/** The same refusal as an HTTP response, for the edges that answer before a pipeline runs. */
export const geminiGenerateContentErrorResponse = (status: number, message: string): Response => {
  const failure = mintGeminiGenerateContentFailure({ status, message });
  return Response.json(failure.body, { status: failure.status });
};

/** The Google-RPC name for an HTTP status. Private, because a caller holding only the name
 *  can write an envelope whose code contradicts it — which is the whole reason the two are
 *  minted together above. */
const geminiGenerateContentStatusForHttpStatus = (status: number): string => {
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
