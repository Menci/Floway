import type { ScopeExpressionData } from './scope-expression';
import type { AccessPrincipal } from '@floway-dev/gateway/browser';

export const principalKey = (principal: AccessPrincipal) => `${principal.kind}:${principal.id}`;

export const parsePrincipal = (value: string): AccessPrincipal | null => {
  const [kind, rawId] = value.split(':');
  const id = Number(rawId);
  return (kind === 'user' || kind === 'group') && Number.isInteger(id) && id > 0 ? { kind, id } : null;
};

export const principalName = (principal: AccessPrincipal, data: ScopeExpressionData): string => principal.kind === 'user'
  ? data.users.find(user => user.id === principal.id)?.username ?? String(principal.id)
  : data.groups.find(group => group.id === principal.id)?.name ?? String(principal.id);
