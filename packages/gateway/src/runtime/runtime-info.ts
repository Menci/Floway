import { getEnvOptional, getRuntimeKind, type RuntimeKind } from '@floway-dev/platform';

export interface RuntimeInfo {
  kind: RuntimeKind;
  colo: string;
}

// Location tag for the incoming request, always non-empty and uppercase.
// On Cloudflare the value is `request.cf.colo`; on Node it comes from the
// operator-set `RUNTIME_LOCATION` env var and defaults to `LOCAL`. Uppercasing
// keeps the value aligned with the dashboard's colo whitelist input, which is
// uppercased at write time (see `normalizeProxyFallbackList`).
export const getCurrentColo = (request: Request): string => {
  if (getRuntimeKind() === 'cloudflare') {
    const cf = (request as Request & { cf?: { colo?: unknown } }).cf;
    if (typeof cf?.colo !== 'string' || cf.colo.length === 0) {
      throw new Error('Cloudflare runtime: request.cf.colo is missing');
    }
    return cf.colo.toUpperCase();
  }
  const raw = getEnvOptional('RUNTIME_LOCATION', '');
  return raw.length > 0 ? raw.toUpperCase() : 'LOCAL';
};

export const getRuntimeInfo = (request: Request): RuntimeInfo => ({
  kind: getRuntimeKind(),
  colo: getCurrentColo(request),
});

// Resolve the externally visible Floway origin (scheme + host, no trailing
// slash) the request reached us on. On Cloudflare the inbound request URL
// already carries the real public scheme and host, so it is authoritative and
// a forwarded-proto header — which an untrusted client can spoof — is ignored.
//
// The Node target typically sits behind a reverse proxy. The bundled
// `docker/nginx.conf` is a plain HTTP reverse proxy — it only `listen 80` and
// forwards to `http://server:8788`, so on its own the request URL the app sees
// always reads `http://<host>`. TLS is terminated elsewhere: either in an
// operator's own proxy in front of that nginx, or in a custom proxy pointed
// straight at Node. The terminator's `X-Forwarded-Proto` is then the only
// signal that recovers the real public scheme. nginx forwards that header only
// as a validated single `http`/`https` token (else its own `$scheme`), and we
// mirror the same bound here: on Node we honor `X-Forwarded-Proto` only as one
// `http`/`https` value that overrides the scheme, always keeping the request
// URL's own host — a forwarded host is never trusted. A missing, comma-chained,
// or otherwise invalid value falls back to the request URL's protocol.
export const getRequestOrigin = (request: Request): string => {
  const url = new URL(request.url);
  if (getRuntimeKind() === 'node') {
    const forwardedProto = request.headers.get('x-forwarded-proto');
    if (forwardedProto === 'http' || forwardedProto === 'https') url.protocol = `${forwardedProto}:`;
  }
  return url.origin;
};
