import { orderedRecords } from './order';
import { principalKey, principalName } from './principals';
import { scopeContains, scopeKey } from './scope';
import type { ScopeExpressionData } from './scope-expression';
import { permissionValueLabel } from './values';
import type { AccessRecord } from '../../api/types';
import type { TFunction } from '../../i18n/translation';
import type { AccessPermission, AccessPrincipal, AccessResolution, AccessScope, PermissionDecisions } from '@floway-dev/gateway/browser';

export const selectPermissionRules = ({ records, principal, scope, showEffective, data, resolution }: {
  records: readonly AccessRecord[];
  principal: AccessPrincipal | null;
  scope: AccessScope | null;
  showEffective: boolean;
  data: ScopeExpressionData;
  resolution?: AccessResolution | null;
}): { records: AccessRecord[]; decisions: Map<number, PermissionDecisions> | null } => {
  const groups = principal?.kind === 'user' ? data.users.find(user => user.id === principal.id)?.groupIds ?? [] : [];
  const applicable = principal === null ? records : records.filter(record => principalKey(record.principal) === principalKey(principal)
    || (record.principal.kind === 'group' && groups.includes(record.principal.id)));
  if (principal !== null && scope !== null && showEffective) return {
    records: orderedRecords(resolution ? resolution.records : applicable.filter(record => scopeContains(record.scope, scope, data))),
    decisions: resolution === undefined || resolution === null ? null : new Map(resolution.decisions.map(row => [row.recordId, row.permissions])),
  };
  return { records: orderedRecords(applicable.filter(record => scopeContains(scope, record.scope, data))), decisions: null };
};

export const permissionSearchText = (record: AccessRecord, data: ScopeExpressionData, t: TFunction): string => {
  const scope = record.scope;
  const target = scope.kind === 'user' ? data.users.find(user => user.id === scope.userId)?.username
    : scope.kind === 'group' ? data.groups.find(group => group.id === scope.groupId)?.name
      : scope.kind === 'upstream' || scope.kind === 'upstreamModel' ? data.upstreams.find(upstream => upstream.id === scope.upstreamId)?.name : '';
  return [
    principalName(record.principal, data), scope.kind, scopeKey(scope), target,
    t(`dashboard.accessControl.scope.kinds.${scope.kind.startsWith('upstream') ? 'upstream'
      : scope.kind === 'self' ? 'self' : scope.kind === 'groups' || scope.kind === 'group' ? 'group' : 'user'}`),
    scope.kind === 'upstreamModel' ? scope.model.value : '',
    ...Object.keys(record.values).flatMap(key => {
      const permission = key as AccessPermission;
      const value = record.values[permission];
      if (value === undefined) return [];
      const label = t(`dashboard.accessControl.columns.${permission}`);
      const level = permissionValueLabel(value, t);
      return [permission, label, level, t('dashboard.accessControl.permissionWithLevel', { permission: label, level })];
    }),
  ].join(' ').toLowerCase();
};
