export interface ProviderModelsFailureResponse {
  status: number;
  headers: [string, string][];
  body: string;
}

const MAX_FAILURE_BODY_LENGTH = 12_288;

const displayFailureBody = (body: string, redact: (text: string) => string = text => text): string => {
  let display = body;
  try {
    display = JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    // A non-JSON upstream error body is displayed as text.
  }
  const safeDisplay = redact(display);
  return safeDisplay.length > MAX_FAILURE_BODY_LENGTH
    ? `${safeDisplay.slice(0, MAX_FAILURE_BODY_LENGTH)}…`
    : safeDisplay;
};

export class ProviderModelsUnavailableError extends Error {
  readonly displayResponse: ProviderModelsFailureResponse | null;

  constructor(
    readonly httpResponse: { status: number; headers: Headers; body: string } | null,
    cause?: unknown,
    displayResponse?: ProviderModelsFailureResponse | null,
  ) {
    super('Provider model listing failed', cause !== undefined ? { cause } : undefined);
    this.name = 'ProviderModelsUnavailableError';
    this.displayResponse = displayResponse ?? (httpResponse === null ? null : {
      status: httpResponse.status,
      headers: [...httpResponse.headers],
      body: displayFailureBody(httpResponse.body),
    });
  }
}

export const redactProviderModelsFailure = (
  failure: ProviderModelsUnavailableError,
  redact: (text: string) => string,
): ProviderModelsUnavailableError => {
  const response = failure.httpResponse;
  if (response === null) {
    const display = failure.displayResponse;
    if (display === null) return failure;
    return new ProviderModelsUnavailableError(null, failure, {
      ...display,
      headers: display.headers.map(([name, value]) => [name, redact(value)]),
      body: redact(display.body),
    });
  }
  const headers = new Headers([...response.headers].map(([name, value]) => [name, redact(value)]));
  return new ProviderModelsUnavailableError({ status: response.status, headers, body: redact(response.body) }, failure, {
    status: response.status,
    headers: [...headers],
    body: displayFailureBody(response.body, redact),
  });
};

// Reconstruct a Response from the captured upstream HTTP frame, or null
// when none was captured (e.g. network errors or malformed bodies) — that
// null lets callers choose their own fallback shape.
export const httpResponseToResponse = (httpResponse: ProviderModelsUnavailableError['httpResponse']): Response | null => {
  if (!httpResponse) return null;
  return new Response(httpResponse.body, {
    status: httpResponse.status,
    headers: new Headers(httpResponse.headers),
  });
};

// Shared scaffold for "fetch the upstream's /models, decode JSON, validate
// shape" — error envelope identical across providers (network / JSON-parse
// / shape-invalid ⇒ ProviderModelsUnavailableError(null, cause); non-2xx
// ⇒ status+headers+body).
export const fetchUpstreamModels = async <T>(
  doFetch: () => Promise<Response>,
  parse: (json: unknown) => T | null,
): Promise<T> => {
  let response: Response;
  try {
    response = await doFetch();
  } catch (cause) {
    throw new ProviderModelsUnavailableError(null, cause);
  }
  if (!response.ok) {
    throw new ProviderModelsUnavailableError({
      status: response.status,
      headers: new Headers(response.headers),
      body: await response.text(),
    });
  }
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (cause) {
    throw new ProviderModelsUnavailableError(null, cause);
  }
  const result = parse(parsed);
  if (result === null) {
    throw new ProviderModelsUnavailableError(null, new Error('Invalid /models response shape'));
  }
  return result;
};
