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
