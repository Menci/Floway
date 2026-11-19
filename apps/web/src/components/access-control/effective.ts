import { orderedRecords } from './order';
import { filterPrincipalRecords, principalName } from './principals';
import { resolveAccess } from './resolution';
import { scopeContains, scopeKey, scopeKind, scopeResourceName } from './scope';
import type { ScopeExpressionData } from './scope-expression';
import { permissionValueLabel } from './values';
import type { AccessRecord } from '../../api/types';
import type { TFunction } from '../../i18n/translation';
import type { AccessPermission, AccessPrincipal, AccessScope, PermissionDecisions } from '@floway-dev/gateway/browser';

export const selectPermissionRules = ({ records, principal, scope, showEffective, data }: {
  records: readonly AccessRecord[];
  principal: AccessPrincipal | null;
  scope: AccessScope | null;
  showEffective: boolean;
  data: ScopeExpressionData;
}): { records: AccessRecord[]; decisions: Map<number, PermissionDecisions> | null } => {
  if (principal !== null && scope !== null && showEffective) {
    const resolution = resolveAccess({ data, principal, records, scope });
    if (resolution !== null) {
      return {
        records: orderedRecords(resolution.records),
        decisions: new Map(resolution.decisions.map(row => [row.recordId, row.permissions])),
      };
    }
  }
  const applicable = filterPrincipalRecords(records, principal, data);
  return { records: orderedRecords(applicable.filter(record => scopeContains(scope, record.scope, data))), decisions: null };
};

export const permissionSearchText = (record: AccessRecord, data: ScopeExpressionData, t: TFunction): string => {
  const scope = record.scope;
  const kind = scopeKind(scope)!;
  return [
    principalName(record.principal, data), scope.kind, scopeKey(scope), scopeResourceName(scope, data) ?? '',
    t(`dashboard.accessControl.scope.kinds.${kind}`),
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
