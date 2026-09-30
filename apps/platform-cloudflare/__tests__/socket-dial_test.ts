import { connect } from 'cloudflare:sockets';
import { afterEach, expect, it, vi } from 'vitest';

import { cloudflareSocketDial } from '../src/socket-dial.ts';

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

  expect(error.message).toBe('dial example.com:443 failed');
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
