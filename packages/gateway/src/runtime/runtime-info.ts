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
// The Node target may sit behind the bundled reverse proxy, which terminates
// TLS and forwards over plain HTTP to the app: `docker/nginx.conf` sets
// `proxy_set_header X-Forwarded-Proto $scheme` and `proxy_pass`es to
// `http://server:8788`, so the app sees `http://<public-host>` and only that
// header recovers the real scheme. We therefore honor `X-Forwarded-Proto` on
// Node alone, and only as a bounded single `http`/`https` value that overrides
// the scheme while always keeping the request URL's own host — a forwarded
// host is never trusted. A missing, comma-chained, or otherwise invalid value
// falls back to the request URL's protocol.
export const getRequestOrigin = (request: Request): string => {
  const url = new URL(request.url);
  if (getRuntimeKind() === 'node') {
    const forwardedProto = request.headers.get('x-forwarded-proto');
    if (forwardedProto === 'http' || forwardedProto === 'https') url.protocol = `${forwardedProto}:`;
  }
  return url.origin;
};
