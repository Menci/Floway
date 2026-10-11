// @floway-dev/proxy — proxy URI parsing, per-protocol byte-stream dialers,
// and a `runProxiedRequest` orchestrator that composes dial → optional
// userspace TLS → fetch-on-stream over a caller-supplied `SocketDial`.

export type { ProxyRequestTarget, SocketDial } from './types.ts';

export { parseProxyUri } from './url.ts';

export type { ProxyConfig } from './proxy-config.ts';

export { ProxyDialError } from './dial-error.ts';
export { ProxyUriError } from './uri-error.ts';

export { runDirectConnectRequest, runProxiedRequest } from './dialer.ts';
export type { RunDirectConnectRequestOptions, RunProxiedRequestOptions } from './dialer.ts';
