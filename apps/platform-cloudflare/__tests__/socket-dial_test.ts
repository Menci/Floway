import { connect } from 'cloudflare:sockets';
import { afterEach, expect, it, vi } from 'vitest';

import { connectRaw, startFixtureTlsServer } from '../../../packages/http/__tests__/test-utils/tls-server.ts';
import { cloudflareSocketDial } from '../src/socket-dial.ts';
import { fetchOnStream, UpstreamTransportError } from '@floway-dev/http';

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

it.each([true, false])('classifies a writable socket failure from workerd when identified=%s', async network => {
  const failure = network ? Object.assign(new Error('Network connection lost.'), { retryable: true }) : new TypeError('socket adapter defect');
  vi.mocked(connect).mockReturnValue({
    opened: Promise.resolve(),
    closed: Promise.resolve(),
    readable: new ReadableStream<Uint8Array>(),
    writable: new WritableStream<Uint8Array>({ write() { throw failure; } }),
    close: async () => {},
  });
  const socket = await cloudflareSocketDial.connect('example.com', 443);
  const writer = socket.writable.getWriter();
  const result = await writer.write(new Uint8Array([5])).catch((error: unknown) => error);
  if (network) {
    expect(result).toBeInstanceOf(UpstreamTransportError);
    expect(result).toMatchObject({ cause: failure });
  } else {
    expect(result).toBe(failure);
  }
  writer.releaseLock();
  await socket.close();
});

it.each(['abort', 'fin', 'failure', 'late failure'] as const)('reports a pending socket read as %s from its actual operation', async outcome => {
  const pulling = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  const controller = new AbortController();
  const reason = new Error('owned abort');
  const failure = new Error('socket read failed independently');
  let source!: ReadableStreamDefaultController<Uint8Array>;
  vi.mocked(connect).mockReturnValue({
    opened: Promise.resolve(),
    closed: closed.promise,
    readable: new ReadableStream<Uint8Array>({
      start(controller) { source = controller; },
      pull() { pulling.resolve(); },
    }, { highWaterMark: 0 }),
    writable: new WritableStream<Uint8Array>(),
    close: async () => { closed.resolve(); },
  });

  const socket = await cloudflareSocketDial.connect('example.com', 443, { signal: controller.signal });
  const reader = socket.readable.getReader();
  const pending = reader.read();
  await pulling.promise;
  if (outcome === 'fin') source.close();
  if (outcome === 'failure') source.error(failure);
  controller.abort(reason);
  if (outcome === 'late failure') source.error(failure);
  if (outcome === 'fin') await expect(pending).resolves.toMatchObject({ done: true });
  else if (outcome === 'failure') await expect(pending).rejects.toMatchObject({ cause: failure });
  else await expect(pending).rejects.toBe(reason);
  await closed.promise;
  reader.releaseLock();
});

it('preserves the converted AbortError when a primitive reason interrupts socket.opened', async () => {
  const opened = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  const controller = new AbortController();
  vi.mocked(connect).mockReturnValue({
    opened: opened.promise,
    closed: closed.promise,
    readable: new ReadableStream<Uint8Array>(),
    writable: new WritableStream<Uint8Array>(),
    close: async () => { closed.resolve(); },
  });
  const pending = cloudflareSocketDial.connect('example.com', 443, { signal: controller.signal });
  controller.abort('caller cancelled');
  await expect(pending).rejects.toMatchObject({ name: 'AbortError', message: 'caller cancelled' });
  await closed.promise;
});

it.each(['rejects', 'stays pending'])('closes the native socket while readable cancellation %s', async mode => {
  const pulling = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  const controller = new AbortController();
  const reason = new Error('caller cancelled');
  vi.mocked(connect).mockReturnValue({
    opened: Promise.resolve(),
    closed: closed.promise,
    readable: new ReadableStream<Uint8Array>({
      pull() { pulling.resolve(); },
      cancel() { return mode === 'rejects' ? Promise.reject(new Error('cancel rejected')) : cancelled.promise; },
    }, { highWaterMark: 0 }),
    writable: new WritableStream<Uint8Array>(),
    close: async () => { closed.resolve(); },
  });
  const socket = await cloudflareSocketDial.connect('example.com', 443, { signal: controller.signal });
  const reader = socket.readable.getReader();
  const pending = reader.read();
  await pulling.promise;
  controller.abort(reason);
  await expect(pending).rejects.toBe(reason);
  await closed.promise;
  cancelled.resolve();
  reader.releaseLock();
});

it.each(['fin before abort', 'failure before abort', 'abort before fin', 'abort before failure'] as const)('preserves %s through userspace HTTPS', async order => {
  const server = await startFixtureTlsServer(socket => {
    socket.once('data', () => { socket.write('HTTP/1.1 200 OK\r\n\r\nfirst bytes'); });
  });
  const tcp = await connectRaw(server.port);
  const nativeReader = tcp.readable.getReader();
  const closed = Promise.withResolvers<void>();
  const controller = new AbortController();
  let nativeReadPending = false;
  let finished = false;
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const closeNative = async () => {
    finished = true;
    await nativeReader.cancel();
    closed.resolve();
  };
  vi.mocked(connect).mockReturnValue({
    opened: Promise.resolve(),
    closed: closed.promise,
    readable: new ReadableStream<Uint8Array>({
      start(value) { source = value; },
      async pull() {
        nativeReadPending = true;
        const item = await nativeReader.read();
        nativeReadPending = false;
        if (finished) return;
        if (item.done) source.close();
        else source.enqueue(item.value);
      },
      cancel: closeNative,
    }, { highWaterMark: 0 }),
    writable: tcp.writable,
    close: closeNative,
  });

  try {
    const socket = await cloudflareSocketDial.connect('localhost', server.port, { signal: controller.signal });
    const secure = await cloudflareSocketDial.startTls(socket, { host: 'localhost', insecure: true, signal: controller.signal });
    const response = await fetchOnStream(secure, { method: 'GET', path: '/', headers: [['Host', 'localhost']] });
    const body = response.body!.getReader();
    expect(new TextDecoder().decode((await body.read()).value)).toBe('first bytes');
    const pending = body.read();
    await vi.waitFor(() => expect(nativeReadPending).toBe(true));
    const reason = new Error('owned cancellation');
    const failure = new Error('independent TCP failure');
    const finish = () => {
      finished = true;
      if (order.includes('fin')) source.close();
      else source.error(failure);
    };
    if (!order.startsWith('abort')) finish();
    controller.abort(reason);
    if (order.startsWith('abort')) finish();

    if (order === 'fin before abort') await expect(pending).resolves.toMatchObject({ done: true });
    else if (order === 'failure before abort') await expect(pending).rejects.toMatchObject({ cause: failure });
    else await expect(pending).rejects.toBe(reason);
    body.releaseLock();
  } finally {
    await closeNative();
    await server.close();
  }
});
