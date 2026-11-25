import type { HttpBody, HttpStreamError } from './facts.ts';
import type { ManagedStream, Result } from '@floway-dev/pipeline';

export const isHttpBodyStream = (body: HttpBody): body is ManagedStream<Uint8Array, HttpStreamError> =>
  typeof body === 'object' && body !== null && Symbol.asyncIterator in body;

export const readHttpBody = async (body: HttpBody): Promise<Result<Uint8Array, HttpStreamError>> => {
  if (body === null) return { ok: true, value: new Uint8Array() };
  if (body instanceof Uint8Array) return { ok: true, value: body };
  if (!isHttpBodyStream(body)) {
    return { ok: true, value: new TextEncoder().encode(typeof body === 'string' ? body : JSON.stringify(body)) };
  }

  const chunks: Uint8Array[] = [];
  let length = 0;
  let failure: Result<never, HttpStreamError> | undefined;
  for await (const item of body) {
    if (!item.ok) {
      failure = item;
      continue;
    }
    chunks.push(item.value);
    length += item.value.byteLength;
  }
  if (failure) return failure;

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, value: bytes };
};

export const readHttpResponseBody = async function* (
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<Result<Uint8Array, HttpStreamError>> {
  const reader = body.getReader();
  let cancellation: Promise<{ readonly cause: unknown } | undefined> | undefined;
  const cancel = (): void => {
    cancellation = reader.cancel(signal.reason).then(() => undefined, (cause: unknown) => ({ cause }));
  };
  if (signal.aborted) cancel();
  else signal.addEventListener('abort', cancel, { once: true });

  try {
    while (!signal.aborted) {
      let item: ReadableStreamReadResult<Uint8Array>;
      try {
        item = await reader.read();
      } catch (cause) {
        if (signal.aborted) break;
        yield { ok: false, error: { kind: 'transport', cause } };
        return;
      }
      if (signal.aborted) break;
      if (item.done) return;
      yield { ok: true, value: item.value };
    }

    const failure = await cancellation;
    const reason: unknown = signal.reason;
    const cause = failure && failure.cause !== reason
      ? new AggregateError([reason, failure.cause], 'HTTP response body cancellation failed')
      : reason;
    yield { ok: false, error: { kind: 'abort', cause } };
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
};
