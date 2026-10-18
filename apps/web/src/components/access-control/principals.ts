import type { ScopeExpressionData } from './scope-expression';
import type { AccessPrincipal } from '@floway-dev/gateway/browser';

export const principalKey = (principal: AccessPrincipal) => `${principal.kind}:${principal.id}`;

export const parsePrincipal = (value: string): AccessPrincipal | null => {
  const match = /^(user|group):([1-9]\d*)$/.exec(value);
  if (match === null) return null;
  const kind = match[1] as AccessPrincipal['kind'];
  const id = Number(match[2]);
  return Number.isSafeInteger(id) ? { kind, id } : null;
};

export const principalName = (principal: AccessPrincipal, data: ScopeExpressionData): string => principal.kind === 'user'
  ? data.users.find(user => user.id === principal.id)?.username ?? String(principal.id)
  : data.groups.find(group => group.id === principal.id)?.name ?? String(principal.id);
