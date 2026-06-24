import { getEnvOptional, getRuntimeKind, type RuntimeKind } from '@floway-dev/platform';

export interface RuntimeInfo {
  kind: RuntimeKind;
  colo: string | null;
}

export const getCurrentColo = (request: Request): string | null => {
  if (getRuntimeKind() === 'cloudflare') {
    const colo = (request as Request & { cf?: { colo?: unknown } }).cf?.colo;
    return typeof colo === 'string' && colo.length > 0 ? colo : null;
  }
  // On Node, RUNTIME_LOCATION lets operators tag each instance; unset means no colo concept.
  const env = getEnvOptional('RUNTIME_LOCATION', '');
  return env.length > 0 ? env : null;
};

export const getRuntimeInfo = (request: Request): RuntimeInfo => ({
  kind: getRuntimeKind(),
  colo: getCurrentColo(request),
});
