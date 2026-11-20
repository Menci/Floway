import type { ScopeExpressionData } from './scope-expression';
import type { AccessRecord } from '../../api/types';
import type { AccessPrincipal } from '@floway-dev/gateway/browser';

export const principalKey = (principal: AccessPrincipal) => `${principal.kind}:${principal.id}`;

export const parsePrincipal = (value: string): AccessPrincipal | null => {
  const match = /^(user|group):([1-9]\d*)$/.exec(value);
  if (match === null) return null;
  const kind = match[1] as AccessPrincipal['kind'];
  const id = Number(match[2]);
  return Number.isSafeInteger(id) ? { kind, id } : null;
};

export const principalName = (principal: AccessPrincipal, data: Pick<ScopeExpressionData, 'groups' | 'users'>): string => principal.kind === 'user'
  ? data.users.find(user => user.id === principal.id)?.username ?? String(principal.id)
  : data.groups.find(group => group.id === principal.id)?.name ?? String(principal.id);

export const principalGroupIds = (principal: AccessPrincipal | null, data: Pick<ScopeExpressionData, 'users'>): readonly number[] =>
  principal?.kind === 'user' ? data.users.find(user => user.id === principal.id)?.groupIds ?? [] : [];

export const filterPrincipalRecords = (
  records: readonly AccessRecord[],
  principal: AccessPrincipal | null,
  data: Pick<ScopeExpressionData, 'users'>,
): AccessRecord[] => {
  if (principal === null) return [...records];
  const groupIds = new Set(principalGroupIds(principal, data));
  const key = principalKey(principal);
  return records.filter(record => principalKey(record.principal) === key
    || (principal.kind === 'user' && record.principal.kind === 'group' && groupIds.has(record.principal.id)));
};
