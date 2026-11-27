import { connect } from 'cloudflare:sockets';
import { afterEach, expect, it, vi } from 'vitest';

import { cloudflareSocketDial } from '../src/socket-dial.ts';
import { HttpTransportError } from '@floway-dev/http';

const failedSocket = (cause: Error): ReturnType<typeof connect> => ({
  opened: Promise.reject(cause),
  closed: Promise.reject(cause),
  readable: new ReadableStream<Uint8Array>(),
  writable: new WritableStream<Uint8Array>(),
  close: vi.fn(async () => {}),
});

const rejectedConnect = async (): Promise<Error> => {
  const error: unknown = await cloudflareSocketDial.connect('example.com', 443).then(
    () => undefined,
    error => error,
  );
  if (!(error instanceof Error)) throw new Error('expected connect to reject with an Error');
  return error;
};

afterEach(() => vi.mocked(connect).mockReset());

it.each([
  'proxy request failed, cannot connect to the specified address',
  'proxy request failed, cannot connect to the specified address. It looks like you might be trying to connect to a HTTP-based service — consider using fetch instead',
])('tags a workerd CONNECT rejection from socket.opened: %s', async message => {
  const cause = new Error(message);
  vi.mocked(connect).mockReturnValue(failedSocket(cause));

  const error = await rejectedConnect();

  expect(error.cause).toBe(cause);
  expect(cloudflareSocketDial.shouldConnectErrorFallbackToFetch?.(error)).toBe(true);
});

it('does not tag other opened failures or synchronous connect errors', async () => {
  vi.mocked(connect).mockReturnValueOnce(failedSocket(new Error('TLS handshake failed')));
  const openedError = await rejectedConnect();
  expect(cloudflareSocketDial.shouldConnectErrorFallbackToFetch?.(openedError)).toBe(false);

  const synchronousError = new Error('proxy request failed, cannot connect to the specified address');
  vi.mocked(connect).mockImplementationOnce(() => { throw synchronousError; });
  const thrown = await rejectedConnect();
  expect(thrown).toBe(synchronousError);
  expect(cloudflareSocketDial.shouldConnectErrorFallbackToFetch?.(thrown)).toBe(false);
});

const openedSocket = () => {
  const closed = Promise.withResolvers<void>();
  const writing = Promise.withResolvers<void>();
  const write = Promise.withResolvers<void>();
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const socket: ReturnType<typeof connect> = {
    opened: Promise.resolve(),
    closed: closed.promise,
    readable: new ReadableStream<Uint8Array>({ start(controller) { source = controller; } }),
    writable: new WritableStream<Uint8Array>({
      write() { writing.resolve(); return write.promise; },
    }),
    close: vi.fn(async () => { write.resolve(); closed.resolve(); }),
  };
  vi.mocked(connect).mockReturnValueOnce(socket);
  return { source, writing, socket };
};

it.each(['before', 'pending', 'between'] as const)('reports the original socket abort cause %s reading', async phase => {
  const { source, writing, socket } = openedSocket();
  const caller = new AbortController();
  const reason = new Error('caller cancelled');
  const connection = await cloudflareSocketDial.connect('example.com', 443, { signal: caller.signal });
  const reader = connection.readable.getReader();
  const writer = connection.writable.getWriter();
  const write = expect(writer.write(new Uint8Array([0]))).rejects.toBe(reason);
  await writing.promise;
  if (phase === 'between') {
    source.enqueue(new Uint8Array([1]));
    expect(await reader.read()).toEqual({ value: new Uint8Array([1]), done: false });
  }
  const pending = phase === 'pending' ? reader.read() : undefined;
  caller.abort(reason);
  await expect(pending ?? reader.read()).rejects.toBe(reason);
  await write;
  await connection.close();
  expect(socket.close).toHaveBeenCalledOnce();
  expect(socket.readable.locked).toBe(false);
  expect(socket.writable.locked).toBe(false);
});

it('preserves a native socket error that landed before the caller abort', async () => {
  const { source } = openedSocket();
  const caller = new AbortController();
  const connection = await cloudflareSocketDial.connect('example.com', 443, { signal: caller.signal });
  const nativeFailure = Object.assign(new Error('Network connection lost.'), { retryable: true });
  source.error(nativeFailure);
  caller.abort(new Error('late cancellation'));
  const failure = await connection.readable.getReader().read().catch((cause: unknown) => cause);
  expect(failure).toBeInstanceOf(HttpTransportError);
  expect((failure as HttpTransportError).cause).toBe(nativeFailure);
  await connection.close();
});
