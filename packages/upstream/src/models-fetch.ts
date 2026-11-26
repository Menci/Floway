export interface UpstreamModelsFailureResponse {
  status: number;
  headers: [string, string][];
  body: string;
}

const MAX_FAILURE_BODY_LENGTH = 12_288;

const displayFailureBody = (body: string): string => {
  let display = body;
  try {
    display = JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    // A non-JSON upstream error body is displayed as text.
  }
  return display.length > MAX_FAILURE_BODY_LENGTH
    ? `${display.slice(0, MAX_FAILURE_BODY_LENGTH)}…`
    : display;
};

export class UpstreamModelsUnavailableError extends Error {
  readonly displayResponse: UpstreamModelsFailureResponse | null;

  constructor(
    readonly httpResponse: { status: number; headers: Headers; body: string } | null,
    cause?: unknown,
    displayResponse?: UpstreamModelsFailureResponse | null,
  ) {
    super('Upstream model listing failed', cause !== undefined ? { cause } : undefined);
    this.name = 'UpstreamModelsUnavailableError';
    this.displayResponse = displayResponse ?? (httpResponse === null ? null : {
      status: httpResponse.status,
      headers: [...httpResponse.headers],
      body: displayFailureBody(httpResponse.body),
    });
  }
}

// Shared scaffold for "fetch the upstream's /models, decode JSON, validate
// shape" — error envelope identical across providers (network / JSON-parse
// / shape-invalid ⇒ UpstreamModelsUnavailableError(null, cause); non-2xx
// ⇒ status+headers+body).
export const fetchUpstreamModels = async <T>(
  doFetch: () => Promise<Response>,
  parse: (json: unknown) => T | null,
): Promise<T> => {
  let response: Response;
  try {
    response = await doFetch();
  } catch (cause) {
    throw new UpstreamModelsUnavailableError(null, cause);
  }
  if (!response.ok) {
    throw new UpstreamModelsUnavailableError({
      status: response.status,
      headers: new Headers(response.headers),
      body: await response.text(),
    });
  }
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (cause) {
    throw new UpstreamModelsUnavailableError(null, cause);
  }
  const result = parse(parsed);
  if (result === null) {
    throw new UpstreamModelsUnavailableError(null, new Error('Invalid /models response shape'));
  }
  return result;
};
