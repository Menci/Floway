import { formatHostForUri } from './bytes.ts';
import { DEFAULT_DIAL_DEADLINE_MS } from './constants.ts';
import { ProxyDialError } from './dial-error.ts';
import { connectOrDialError } from './dial-target.ts';
import { dialHttpConnect } from './protocols/http-connect.ts';
import { dialReality } from './protocols/reality.ts';
import { dialShadowsocks2022 } from './protocols/shadowsocks-2022.ts';
import { dialShadowsocks } from './protocols/shadowsocks.ts';
import { dialSocks5 } from './protocols/socks5.ts';
import { dialTrojan } from './protocols/trojan.ts';
import { dialVlessTcpTls, dialVlessWsTls } from './protocols/vless.ts';
import type { ProxyConfig } from './proxy-config.ts';
import type { DialOptions, DialResult, DialTarget, ProxyRequestTarget } from './types.ts';
import { fetchOnStream, HttpTransportError, isCausedBy, signalAbortReason, type DuplexStream, type FetchResponse, type HttpRequest, type TlsStream } from '@floway-dev/http';

/**
 * Open a transport-only duplex byte stream to `target.host:target.port`
 * through the named proxy. The returned stream is plain bytes — no inner
 * TLS to the upstream and no HTTP/1.1 framing — so the caller is free to
 * layer those (or anything else) on top.
 */
export const dial = async (
  config: ProxyConfig,
  target: DialTarget,
  options: DialOptions,
): Promise<DialResult> =>
  await withDialDeadline(
    options,
    () => new ProxyDialError(
      `${config.kind}: dial to ${config.host}:${config.port} → ${target.host}:${target.port} exceeded deadline of ${options.dialTimeoutMs ?? DEFAULT_DIAL_DEADLINE_MS}ms`,
      'tcp-connect',
    ),
    async innerOptions => {
      try {
        return await dispatchDial(config, target, innerOptions);
      } catch (cause) {
        if (cause instanceof HttpTransportError && !isCausedBy(cause, innerOptions.signal?.reason)) {
          throw new ProxyDialError('proxy handshake transport failed', 'proxy-handshake', { cause });
        }
        throw cause;
      }
    },
  );

const withDialDeadline = async <T>(
  options: DialOptions,
  timeoutError: () => ProxyDialError,
  run: (options: DialOptions) => Promise<T>,
): Promise<T> => {
  const deadlineMs = options.dialTimeoutMs ?? DEFAULT_DIAL_DEADLINE_MS;
  const callerSignal = options.signal;
  if (callerSignal?.aborted) {
    throw signalAbortReason(callerSignal);
  }
  // The socket keeps the composed signal for its lifetime. Only the dial
  // deadline is disarmed when the handshake hands the connection off.
  const deadline = new AbortController();
  const signal = callerSignal === undefined ? deadline.signal : AbortSignal.any([callerSignal, deadline.signal]);
  const timer = setTimeout(() => deadline.abort(timeoutError()), deadlineMs);
  try {
    return await run({ ...options, signal });
  } catch (cause) {
    if (isCausedBy(cause, deadline.signal.reason)) throw deadline.signal.reason;
    throw cause;
  } finally {
    clearTimeout(timer);
  }
};

const dispatchDial = async (config: ProxyConfig, target: DialTarget, options: DialOptions): Promise<DialResult> => {
  switch (config.kind) {
  case 'http':
    return await dialHttpConnect(config, target, options);
  case 'socks5':
    return await dialSocks5(config, target, options);
  case 'ss':
    return await dialShadowsocks(config, target, options);
  case 'ss2022':
    return await dialShadowsocks2022(config, target, options);
  case 'trojan':
    return await dialTrojan(config, target, options);
  case 'vless-tcp':
    return await dialVlessTcpTls(config, target, options);
  case 'vless-ws':
    return await dialVlessWsTls(config, target, options);
  case 'reality':
    return await dialReality(config, target, options);
  default: {
    const _: never = config;
    throw new Error(`unknown ProxyConfig kind: ${(config as { kind: string }).kind}`);
  }
  }
};

export type RunProxiedRequestOptions = DialOptions;
export type RunDirectConnectRequestOptions = DialOptions;

/**
 * Compose `dial` → optional TLS upgrade → `fetchOnStream` into a single
 * call that returns a real HTTP `Response` whose body is the upstream's
 * response body (decrypted, transfer-encoding decoded).
 *
 * The dial-stage deadline applies to dial + outer-TLS + proxy-handshake
 * combined; once `dial()` returns the inner-TLS handshake and the
 * upstream's response time are unbounded by this options surface.
 */
export const runProxiedRequest = async (
  config: ProxyConfig,
  target: ProxyRequestTarget,
  request: HttpRequest,
  options: RunProxiedRequestOptions,
): Promise<FetchResponse> => {
  const dialed = await dial(config, target, options);
  return await runRequestOnStream(dialed, target, request, options);
};

/**
 * Run one HTTP request on a raw runtime TCP socket. This deliberately shares
 * the post-dial TLS and HTTP/1.1 pipeline with proxy-backed requests; only the
 * transport that produces the first duplex stream differs.
 */
export const runDirectConnectRequest = async (
  target: ProxyRequestTarget,
  request: HttpRequest,
  options: RunDirectConnectRequestOptions,
): Promise<FetchResponse> => {
  const deadlineMs = options.dialTimeoutMs ?? DEFAULT_DIAL_DEADLINE_MS;
  const socket = await withDialDeadline(
    options,
    () => new ProxyDialError(
      `direct-connect: dial to ${target.host}:${target.port} exceeded deadline of ${deadlineMs}ms`,
      'tcp-connect',
    ),
    innerOptions => connectOrDialError(
      innerOptions.socketDial,
      target.host,
      target.port,
      { signal: innerOptions.signal },
    ),
  );

  return await runRequestOnStream(socket, target, request, options);
};

const runRequestOnStream = async (
  dialed: DialResult,
  target: ProxyRequestTarget,
  request: HttpRequest,
  options: RunProxiedRequestOptions,
): Promise<FetchResponse> => {
  let closed: Promise<void> | undefined;
  const close = (): Promise<void> => closed ??= Promise.resolve().then(() => dialed.close());
  let stream: DuplexStream = { readable: dialed.readable, writable: dialed.writable };
  try {
    if (options.signal?.aborted) throw signalAbortReason(options.signal);
    // Route DialResult.prefix to the next byte sink: into the TLS upgrade
    // when wrapping, otherwise into the fetch-body prefix.
    let fetchPrefix: Uint8Array | undefined;
    if (target.tls) {
      let tls: TlsStream;
      try {
        tls = await options.socketDial.startTls(stream, {
          host: target.sni ?? target.host,
          verifyHost: target.verifyHost ?? target.sni ?? target.host,
          alpn: target.alpn,
          prefix: dialed.prefix,
          signal: options.signal,
        });
      } catch (cause) {
        // The dialer's framing pump can surface a typed ProxyDialError
        // (VLESS bad-version, SS auth fail, …) into the
        // handshake as the underlying transport error. Preserve the original
        // stage rather than mis-tagging it as inner-tls.
        if (cause instanceof HttpTransportError && !isCausedBy(cause, options.signal?.reason)) {
          throw new ProxyDialError('inner tls handshake to upstream failed', 'inner-tls', { cause });
        }
        throw cause;
      }
      stream = tls;
    } else {
      fetchPrefix = dialed.prefix;
    }
    const hasHost = request.headers.some(([name]) => name.toLowerCase() === 'host');
    let headers = request.headers;
    if (!hasHost) {
      // RFC 9110 §7.2: Host = uri-host [ ":" port ]. Omit the port only when
      // it is the scheme's default (443 for HTTPS, 80 for plain HTTP) —
      // strict virtual-host upstreams interpret a bare hostname as "client
      // wants the default port" and route or reject accordingly.
      const hostUriPart = formatHostForUri(target.host);
      const defaultPort = target.tls ? 443 : 80;
      const hostValue = target.port === defaultPort ? hostUriPart : `${hostUriPart}:${target.port}`;
      headers = [['Host', hostValue], ...headers];
    }
    const response = await fetchOnStream(stream, { ...request, headers }, fetchPrefix, options.contentDecoders, options.signal);
    return await closeSocketWithResponse(response, close);
  } catch (err) {
    // Any throw past `dial()` means the active stream will never be returned
    // to the caller. Cancel the topmost layer (the post-TLS readable when
    // the upgrade succeeded, otherwise the dialed readable) so the cancel
    // cascade reaches every wrapper's teardown — a userspace TLS layer ends
    // and closes the transport writer, a native one destroys its socket; each
    // protocol's IIFE / framing pump observes the underlying read failure
    // and closes the socket.
    void stream.readable.cancel(err).catch(() => {});
    await close().catch(() => {});
    throw err;
  }
};

const closeSocketWithResponse = async (response: FetchResponse, close: () => Promise<void>): Promise<FetchResponse> => {
  if (response.body === null) {
    await close();
    return response;
  }

  const reader = response.body.getReader();
  let cancelled = false;
  let released = false;
  const release = (): void => {
    reader.releaseLock();
    released = true;
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch (error) {
        if (cancelled) return;
        release();
        controller.error(error);
        void close().catch(() => {});
        return;
      }
      if (cancelled) return;
      if (result.done) {
        release();
        await close();
        if (!cancelled) controller.close();
      } else {
        controller.enqueue(result.value);
      }
    },
    async cancel(reason) {
      cancelled = true;
      if (!released) {
        try {
          await reader.cancel(reason);
        } catch (cause) {
          void close().catch(() => {});
          throw cause;
        } finally {
          release();
        }
      }
      await close();
    },
  }, { highWaterMark: 0 });

  return Object.assign(new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  }), {
    ...(response.headerLines === undefined ? {} : { headerLines: response.headerLines }),
    classifyBodyFailure: (cause: unknown) => cause instanceof ProxyDialError && cause.stage !== 'config'
      ? { kind: 'transport' as const, cause }
      : response.classifyBodyFailure?.(cause),
  });
};
