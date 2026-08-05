export class ProviderModelsUnavailableError extends Error {
  constructor(
    readonly httpResponse: { status: number; headers: Headers; body: string } | null,
    cause?: unknown,
  ) {
    super('Provider model listing failed', cause !== undefined ? { cause } : undefined);
    this.name = 'ProviderModelsUnavailableError';
  }
}

const DEFAULT_MAX_MODELS_RESPONSE_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_MODELS_ERROR_RESPONSE_BYTES = 64 * 1024;
const TRUNCATED_BODY_MARKER = '...[truncated]';

export interface ResponseByteBudget {
  remainingBytes: number;
}

const bytesToText = (chunks: readonly Uint8Array[], totalBytes: number): string => {
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
};

const readErrorBody = async (response: Response, maxBytes: number): Promise<string> => {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return bytesToText(chunks, totalBytes);
      const remaining = maxBytes - totalBytes;
      if (value.byteLength > remaining) {
        if (remaining > 0) chunks.push(value.slice(0, remaining));
        totalBytes += Math.max(remaining, 0);
        void reader.cancel().catch(() => undefined);
        return `${bytesToText(chunks, totalBytes)}${TRUNCATED_BODY_MARKER}`;
      }
      chunks.push(value);
      totalBytes += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
};

export const readBoundedJsonResponse = async (
  response: Response,
  maxBytes: number,
  budget?: ResponseByteBudget,
): Promise<unknown> => {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new TypeError('maxBytes must be a positive safe integer');
  if (budget && (!Number.isSafeInteger(budget.remainingBytes) || budget.remainingBytes < 0)) {
    throw new TypeError('response byte budget must be a non-negative safe integer');
  }
  if (!response.body) throw new Error('Provider model listing returned an empty body');
  const allowedBytes = Math.min(maxBytes, budget?.remainingBytes ?? maxBytes);
  if (allowedBytes === 0) throw new Error('Provider model listing exhausted its response byte budget');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > allowedBytes) {
        if (budget) budget.remainingBytes = 0;
        void reader.cancel().catch(() => undefined);
        throw new Error(`Provider model listing exceeded ${allowedBytes} response bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  if (budget) budget.remainingBytes -= totalBytes;
  return JSON.parse(bytesToText(chunks, totalBytes)) as unknown;
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
  options: { maxErrorResponseBytes?: number; maxResponseBytes?: number; responseByteBudget?: ResponseByteBudget } = {},
): Promise<T> => {
  const maxErrorResponseBytes = options.maxErrorResponseBytes ?? DEFAULT_MAX_MODELS_ERROR_RESPONSE_BYTES;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_MODELS_RESPONSE_BYTES;
  if (!Number.isSafeInteger(maxErrorResponseBytes) || maxErrorResponseBytes <= 0 || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0) {
    throw new TypeError('model response byte limits must be positive safe integers');
  }
  let response: Response;
  try {
    response = await doFetch();
  } catch (cause) {
    throw new ProviderModelsUnavailableError(null, cause);
  }
  if (!response.ok) {
    const httpResponse: NonNullable<ProviderModelsUnavailableError['httpResponse']> = {
      status: response.status,
      headers: new Headers(response.headers),
      body: '',
    };
    try {
      httpResponse.body = await readErrorBody(response, maxErrorResponseBytes);
    } catch (cause) {
      throw new ProviderModelsUnavailableError(httpResponse, cause);
    }
    throw new ProviderModelsUnavailableError(httpResponse);
  }
  let parsed: unknown;
  try {
    parsed = await readBoundedJsonResponse(response, maxResponseBytes, options.responseByteBudget);
  } catch (cause) {
    throw new ProviderModelsUnavailableError(null, cause);
  }
  const result = parse(parsed);
  if (result === null) {
    throw new ProviderModelsUnavailableError(null, new Error('Invalid /models response shape'));
  }
  return result;
};
