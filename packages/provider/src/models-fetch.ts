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
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export interface ProviderModelsTaskOptions {
  signal?: AbortSignal;
  totalTimeoutMs?: number;
}

interface ProviderModelsReadOptions {
  idleTimeoutMs?: number;
  signal?: AbortSignal;
}

interface NormalizedProviderModelsReadOptions {
  idleTimeoutMs: number;
  signal?: AbortSignal;
}

interface ProviderModelsDeadline {
  error: DOMException;
  errorMappers: Array<(reason: unknown) => unknown>;
  expiresAt: number;
  expire: () => void;
}

const deadlines = new WeakMap<AbortSignal, ProviderModelsDeadline>();
const deadlineErrors = new WeakSet<DOMException>();
const monotonicNow = (): number => performance.now();

const timeoutError = (scope: 'idle' | 'total', timeoutMs: number): DOMException =>
  new DOMException(`Provider model listing ${scope} timeout after ${timeoutMs}ms`, 'TimeoutError');

const validateTimeoutMs = (name: 'idleTimeoutMs' | 'totalTimeoutMs', value: number): number => {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMER_DELAY_MS) {
    throw new TypeError(`${name} must be a positive safe integer no greater than ${MAX_TIMER_DELAY_MS}`);
  }
  return value;
};

const normalizeReadOptions = (options: ProviderModelsReadOptions): NormalizedProviderModelsReadOptions => ({
  idleTimeoutMs: validateTimeoutMs('idleTimeoutMs', options.idleTimeoutMs ?? PROVIDER_MODELS_IDLE_TIMEOUT_MS),
  signal: options.signal,
});

const expireElapsedDeadline = (signal: AbortSignal | undefined): void => {
  if (!signal) return;
  const deadline = deadlines.get(signal);
  if (!deadline || monotonicNow() < deadline.expiresAt) return;
  deadline.expire();
  throw signal.reason ?? deadline.error;
};

const isDeadlineAbort = (signal: AbortSignal): boolean => {
  return signal.aborted && signal.reason instanceof DOMException && deadlineErrors.has(signal.reason);
};

const registerDeadlineErrorMapper = (
  signal: AbortSignal,
  mapper: (reason: unknown) => unknown,
): (() => void) => {
  const deadline = deadlines.get(signal);
  if (!deadline) return () => {};
  deadline.errorMappers.push(mapper);
  return () => {
    const index = deadline.errorMappers.lastIndexOf(mapper);
    if (index !== -1) deadline.errorMappers.splice(index, 1);
  };
};

const raceWithSignal = <T>(operation: Promise<T>, signal: AbortSignal): Promise<T> => {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      let reason = signal.reason;
      const errorMappers = isDeadlineAbort(signal) ? deadlines.get(signal)?.errorMappers : undefined;
      const mapper = errorMappers?.[errorMappers.length - 1];
      if (mapper) {
        try {
          reason = mapper(reason);
        } catch (error) {
          reason = error;
        }
      }
      reject(reason);
    };
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
  const totalTimeoutMs = validateTimeoutMs('totalTimeoutMs', options.totalTimeoutMs ?? PROVIDER_MODELS_TOTAL_TIMEOUT_MS);
  const controller = new AbortController();
  const callerSignal = options.signal;
  const onCallerAbort = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) controller.abort(callerSignal.reason);
  else callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
  if (controller.signal.aborted) throw controller.signal.reason;

  const error = timeoutError('total', totalTimeoutMs);
  deadlineErrors.add(error);
  const ownDeadline: ProviderModelsDeadline = {
    error,
    errorMappers: [],
    expiresAt: monotonicNow() + totalTimeoutMs,
    expire: () => controller.abort(error),
  };
  const callerDeadline = callerSignal ? deadlines.get(callerSignal) : undefined;
  const deadline = callerDeadline && callerDeadline.expiresAt <= ownDeadline.expiresAt ? callerDeadline : ownDeadline;
  deadlines.set(controller.signal, deadline);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    expireElapsedDeadline(controller.signal);
    timer = setTimeout(deadline.expire, Math.max(0, deadline.expiresAt - monotonicNow()));
    return await raceWithSignal(Promise.resolve().then(() => task(controller.signal)), controller.signal);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    deadlines.delete(controller.signal);
    callerSignal?.removeEventListener('abort', onCallerAbort);
  }
};

const DEFAULT_MAX_MODELS_RESPONSE_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_MODELS_ERROR_RESPONSE_BYTES = 64 * 1024;
const READS_PER_EVENT_LOOP_YIELD = 64;
const TRUNCATED_BODY_MARKER = '...[truncated]';
const REWRITTEN_BODY_HEADERS = [
  'content-length',
  'content-encoding',
  'transfer-encoding',
  'content-md5',
  'digest',
  'content-digest',
  'repr-digest',
  'etag',
  'last-modified',
  'content-range',
  'accept-ranges',
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

const cancelReader = (reader: ReadableStreamDefaultReader<Uint8Array>, reason?: unknown): void => {
  void reader.cancel(reason).catch(() => undefined);
};

const cancelBody = (body: ReadableStream<Uint8Array> | null, reason: unknown): void => {
  if (!body) return;
  void body.cancel(reason).catch(() => undefined);
};

const yieldToEventLoop = (signal: AbortSignal | undefined): Promise<void> => {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(signal?.reason));
    timer = setTimeout(() => finish(resolve), 0);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
};

const yieldReadLoop = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal | undefined,
): Promise<void> => {
  try {
    await yieldToEventLoop(signal);
  } catch (error) {
    cancelReader(reader, signal?.aborted ? signal.reason : error);
    throw error;
  }
};

const readWithIdleTimeout = (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  options: NormalizedProviderModelsReadOptions,
): Promise<ReadableStreamReadResult<Uint8Array>> => {
  const signal = options.signal;
  try {
    expireElapsedDeadline(signal);
  } catch (error) {
    cancelReader(reader, error);
    return Promise.reject(error);
  }
  if (signal?.aborted) {
    cancelReader(reader, signal.reason);
    return Promise.reject(signal.reason);
  }
  const operation = reader.read();
  return new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = () => {
      cancelReader(reader, signal?.reason);
      finish(() => reject(signal?.reason));
    };
    const timer = setTimeout(() => {
      const error = timeoutError('idle', options.idleTimeoutMs);
      cancelReader(reader, error);
      finish(() => reject(error));
    }, options.idleTimeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    operation.then(
      value => {
        try {
          expireElapsedDeadline(signal);
          finish(() => resolve(value));
        } catch (error) {
          cancelReader(reader, error);
          finish(() => reject(error));
        }
      },
      error => finish(() => reject(error)),
    );
    if (signal?.aborted) onAbort();
  });
};

const releaseReader = (reader: ReadableStreamDefaultReader<Uint8Array>): void => {
  try {
    reader.releaseLock();
  } catch {
    // A source that ignores cancellation can retain its pending read; the timeout result still wins.
  }
};

interface CapturedErrorBody {
  body: string;
  truncated: boolean;
}

const readErrorBody = async (response: Response, maxBytes: number, options: ProviderModelsReadOptions): Promise<CapturedErrorBody> => {
  const normalizedOptions = normalizeReadOptions(options);
  if (!response.body) return { body: '', truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let readsSinceYield = 0;
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await readWithIdleTimeout(reader, normalizedOptions);
      if (done) return { body: bytesToText(chunks, totalBytes), truncated: false };
      const remaining = maxBytes - totalBytes;
      if (value.byteLength > remaining) {
        if (remaining > 0) chunks.push(value.slice(0, remaining));
        totalBytes += Math.max(remaining, 0);
        cancelReader(reader);
        return { body: `${bytesToText(chunks, totalBytes)}${TRUNCATED_BODY_MARKER}`, truncated: true };
      }
      chunks.push(value);
      totalBytes += value.byteLength;
      readsSinceYield++;
      if (readsSinceYield === READS_PER_EVENT_LOOP_YIELD) {
        readsSinceYield = 0;
        await yieldReadLoop(reader, normalizedOptions.signal);
      }
    }
  } finally {
    releaseReader(reader);
  }
};

const contentTypeParts = (value: string): string[] => {
  const parts: string[] = [];
  let escaped = false;
  let quoted = false;
  let start = 0;
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quoted && character === '\\') {
      escaped = true;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && character === ';') {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(value.slice(start));
  return parts;
};

const rewrittenContentType = (contentType: string): string | null => {
  const [rawEssence = '', ...rawParameters] = contentTypeParts(contentType);
  const essence = rawEssence.trim();
  if (essence === '') return null;
  const parameters: string[] = [];
  let hasCharset = false;
  for (const rawParameter of rawParameters) {
    const parameter = rawParameter.trim();
    if (parameter === '') continue;
    const equalsIndex = parameter.indexOf('=');
    const name = parameter.slice(0, equalsIndex === -1 ? undefined : equalsIndex).trim().toLowerCase();
    if (name === 'charset') {
      if (!hasCharset) parameters.push('charset=utf-8');
      hasCharset = true;
    } else {
      parameters.push(parameter);
    }
  }
  if (!hasCharset && essence.toLowerCase().startsWith('text/')) parameters.push('charset=utf-8');
  return [essence, ...parameters].join('; ');
};

const rewriteCapturedBodyHeaders = (headers: Headers, truncated: boolean): void => {
  const contentType = headers.get('content-type');
  for (const name of REWRITTEN_BODY_HEADERS) headers.delete(name);
  if (truncated) {
    headers.set('content-type', 'text/plain; charset=utf-8');
    return;
  }
  if (contentType !== null) {
    const rewritten = rewrittenContentType(contentType);
    if (rewritten) headers.set('content-type', rewritten);
    else headers.delete('content-type');
  }
};

const validateResponseByteBudget = (budget: ResponseByteBudget | undefined): void => {
  if (budget && (!Number.isSafeInteger(budget.remainingBytes) || budget.remainingBytes < 0)) {
    throw new TypeError('response byte budget must be a non-negative safe integer');
  }
};

export const readBoundedJsonResponse = async (
  response: Response,
  maxBytes: number,
  budget?: ResponseByteBudget,
  options: ProviderModelsReadOptions = {},
): Promise<unknown> => {
  let normalizedOptions: NormalizedProviderModelsReadOptions;
  let allowedBytes: number;
  try {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new TypeError('maxBytes must be a positive safe integer');
    validateResponseByteBudget(budget);
    normalizedOptions = normalizeReadOptions(options);
    allowedBytes = Math.min(maxBytes, budget?.remainingBytes ?? maxBytes);
    if (allowedBytes === 0) throw new Error('Provider model listing exhausted its response byte budget');
  } catch (error) {
    cancelBody(response.body, error);
    throw error;
  }
  if (!response.body) throw new Error('Provider model listing returned an empty body');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let readsSinceYield = 0;
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await readWithIdleTimeout(reader, normalizedOptions);
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > allowedBytes) {
        if (budget) budget.remainingBytes = 0;
        cancelReader(reader);
        throw new Error(`Provider model listing exceeded ${allowedBytes} response bytes`);
      }
      chunks.push(value);
      readsSinceYield++;
      if (readsSinceYield === READS_PER_EVENT_LOOP_YIELD) {
        readsSinceYield = 0;
        await yieldReadLoop(reader, normalizedOptions.signal);
      }
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
export const fetchUpstreamModels = <T>(
  doFetch: (signal: AbortSignal) => Promise<Response>,
  parse: (json: unknown) => T | null,
  options: ProviderModelsTaskOptions & { idleTimeoutMs?: number; maxErrorResponseBytes?: number; maxResponseBytes?: number; responseByteBudget?: ResponseByteBudget } = {},
): Promise<T> => runProviderModelsTask(async signal => {
  const maxErrorResponseBytes = options.maxErrorResponseBytes ?? DEFAULT_MAX_MODELS_ERROR_RESPONSE_BYTES;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_MODELS_RESPONSE_BYTES;
  if (!Number.isSafeInteger(maxErrorResponseBytes) || maxErrorResponseBytes <= 0 || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0) {
    throw new TypeError('model response byte limits must be positive safe integers');
  }
  normalizeReadOptions({ idleTimeoutMs: options.idleTimeoutMs, signal });
  validateResponseByteBudget(options.responseByteBudget);
  if (options.responseByteBudget?.remainingBytes === 0) {
    throw new ProviderModelsUnavailableError(null, new Error('Provider model listing exhausted its response byte budget'));
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
    const mapDeadlineError = (cause: unknown): ProviderModelsUnavailableError => {
      rewriteCapturedBodyHeaders(httpResponse.headers, true);
      return new ProviderModelsUnavailableError(httpResponse, cause);
    };
    const unregisterDeadlineErrorMapper = registerDeadlineErrorMapper(signal, mapDeadlineError);
    try {
      const captured = await readErrorBody(response, maxErrorResponseBytes, { idleTimeoutMs: options.idleTimeoutMs, signal });
      httpResponse.body = captured.body;
      rewriteCapturedBodyHeaders(httpResponse.headers, captured.truncated);
    } catch (cause) {
      rewriteCapturedBodyHeaders(httpResponse.headers, true);
      throw new ProviderModelsUnavailableError(httpResponse, cause);
    } finally {
      unregisterDeadlineErrorMapper();
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
}, options).catch((cause: unknown) => {
  if (options.signal?.aborted && !isDeadlineAbort(options.signal)) throw options.signal.reason;
  if (cause instanceof DOMException && cause.name === 'TimeoutError') {
    throw new ProviderModelsUnavailableError(null, cause);
  }
  throw cause;
});
