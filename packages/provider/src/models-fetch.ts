export class ProviderModelsUnavailableError extends Error {
  constructor(
    readonly httpResponse: { status: number; headers: Headers; body: string } | null,
    cause?: unknown,
  ) {
    super('Provider model listing failed', cause !== undefined ? { cause } : undefined);
    this.name = 'ProviderModelsUnavailableError';
  }
}

export const PROVIDER_MODELS_TOTAL_TIMEOUT_MS = 30_000;
export const PROVIDER_MODELS_IDLE_TIMEOUT_MS = 10_000;

export interface ProviderModelsTaskOptions {
  signal?: AbortSignal;
  totalTimeoutMs?: number;
}

interface ProviderModelsReadOptions {
  idleTimeoutMs?: number;
  signal?: AbortSignal;
}

const timeoutError = (scope: 'idle' | 'total', timeoutMs: number): DOMException =>
  new DOMException(`Provider model listing ${scope} timeout after ${timeoutMs}ms`, 'TimeoutError');

const raceWithSignal = <T>(operation: Promise<T>, signal: AbortSignal): Promise<T> => {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      value => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      error => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
};

export const runProviderModelsTask = async <T>(
  task: (signal: AbortSignal) => Promise<T>,
  options: ProviderModelsTaskOptions = {},
): Promise<T> => {
  const totalTimeoutMs = options.totalTimeoutMs ?? PROVIDER_MODELS_TOTAL_TIMEOUT_MS;
  if (!Number.isSafeInteger(totalTimeoutMs) || totalTimeoutMs <= 0) {
    throw new TypeError('totalTimeoutMs must be a positive safe integer');
  }
  const controller = new AbortController();
  const callerSignal = options.signal;
  const onCallerAbort = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) controller.abort(callerSignal.reason);
  else callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
  if (controller.signal.aborted) throw controller.signal.reason;

  const timer = setTimeout(() => controller.abort(timeoutError('total', totalTimeoutMs)), totalTimeoutMs);
  try {
    return await raceWithSignal(Promise.resolve().then(() => task(controller.signal)), controller.signal);
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', onCallerAbort);
  }
};

const DEFAULT_MAX_MODELS_RESPONSE_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_MODELS_ERROR_RESPONSE_BYTES = 64 * 1024;
const TRUNCATED_BODY_MARKER = '...[truncated]';
const REWRITTEN_BODY_HEADERS = [
  'content-length',
  'content-encoding',
  'transfer-encoding',
  'content-md5',
  'digest',
  'content-digest',
  'repr-digest',
] as const;

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

const readWithIdleTimeout = <T>(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  operation: Promise<T>,
  options: ProviderModelsReadOptions,
): Promise<T> => {
  const idleTimeoutMs = options.idleTimeoutMs ?? PROVIDER_MODELS_IDLE_TIMEOUT_MS;
  if (!Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs <= 0) {
    return Promise.reject(new TypeError('idleTimeoutMs must be a positive safe integer'));
  }
  const signal = options.signal;
  if (signal?.aborted) {
    void reader.cancel(signal.reason).catch(() => undefined);
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = () => {
      void reader.cancel(signal?.reason).catch(() => undefined);
      finish(() => reject(signal?.reason));
    };
    const timer = setTimeout(() => {
      const error = timeoutError('idle', idleTimeoutMs);
      void reader.cancel(error).catch(() => undefined);
      finish(() => reject(error));
    }, idleTimeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    operation.then(
      value => finish(() => resolve(value)),
      error => finish(() => reject(error)),
    );
  });
};

const releaseReader = (reader: ReadableStreamDefaultReader<Uint8Array>): void => {
  try {
    reader.releaseLock();
  } catch {
    // A source that ignores cancellation can retain its pending read; the timeout result still wins.
  }
};

const readErrorBody = async (response: Response, maxBytes: number, options: ProviderModelsReadOptions): Promise<string> => {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await readWithIdleTimeout(reader, reader.read(), options);
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
    releaseReader(reader);
  }
};

const stripRewrittenBodyHeaders = (headers: Headers): void => {
  for (const name of REWRITTEN_BODY_HEADERS) headers.delete(name);
};

export const readBoundedJsonResponse = async (
  response: Response,
  maxBytes: number,
  budget?: ResponseByteBudget,
  options: ProviderModelsReadOptions = {},
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
      const { done, value } = await readWithIdleTimeout(reader, reader.read(), options);
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
    releaseReader(reader);
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
  doFetch: (signal: AbortSignal) => Promise<Response>,
  parse: (json: unknown) => T | null,
  options: ProviderModelsTaskOptions & { idleTimeoutMs?: number; maxErrorResponseBytes?: number; maxResponseBytes?: number; responseByteBudget?: ResponseByteBudget } = {},
): Promise<T> => runProviderModelsTask(async signal => {
  const maxErrorResponseBytes = options.maxErrorResponseBytes ?? DEFAULT_MAX_MODELS_ERROR_RESPONSE_BYTES;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_MODELS_RESPONSE_BYTES;
  if (!Number.isSafeInteger(maxErrorResponseBytes) || maxErrorResponseBytes <= 0 || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0) {
    throw new TypeError('model response byte limits must be positive safe integers');
  }
  let response: Response;
  try {
    response = await doFetch(signal);
  } catch (cause) {
    if (signal.aborted) throw signal.reason;
    throw new ProviderModelsUnavailableError(null, cause);
  }
  if (!response.ok) {
    const httpResponse: NonNullable<ProviderModelsUnavailableError['httpResponse']> = {
      status: response.status,
      headers: new Headers(response.headers),
      body: '',
    };
    try {
      httpResponse.body = await readErrorBody(response, maxErrorResponseBytes, { idleTimeoutMs: options.idleTimeoutMs, signal });
      stripRewrittenBodyHeaders(httpResponse.headers);
    } catch (cause) {
      stripRewrittenBodyHeaders(httpResponse.headers);
      if (signal.aborted) throw signal.reason;
      throw new ProviderModelsUnavailableError(httpResponse, cause);
    }
    throw new ProviderModelsUnavailableError(httpResponse);
  }
  let parsed: unknown;
  try {
    parsed = await readBoundedJsonResponse(response, maxResponseBytes, options.responseByteBudget, { idleTimeoutMs: options.idleTimeoutMs, signal });
  } catch (cause) {
    if (signal.aborted) throw signal.reason;
    throw new ProviderModelsUnavailableError(null, cause);
  }
  const result = parse(parsed);
  if (result === null) {
    throw new ProviderModelsUnavailableError(null, new Error('Invalid /models response shape'));
  }
  return result;
}, options);
