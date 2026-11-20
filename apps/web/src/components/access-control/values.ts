import type { TFunction } from '../../i18n/translation';
import type { BadgeTone } from '../ui/status-badge';
import type { AccessPermission, AccessScope, AccessValues } from '@floway-dev/gateway/browser';

export const ACCESS_PERMISSIONS: readonly AccessPermission[] = ['Model.Use', 'Upstream.Audit', 'Upstream.Edit', 'User.Audit', 'Permission.Audit'];
export type PermissionState = 'on' | 'off' | 'models' | 'full';
export const permissionState = (value: NonNullable<AccessValues[AccessPermission]>): PermissionState => typeof value === 'boolean' ? value ? 'on' : 'off' : value;
export const permissionTone = (value: NonNullable<AccessValues[AccessPermission]>): BadgeTone => value === 'models'
  ? 'accent' : value === true || value === 'full' ? 'success' : 'neutral';
export const permissionValueLabel = (value: NonNullable<AccessValues[AccessPermission]>, t: TFunction): string => typeof value === 'boolean'
  ? t(value ? 'permissions.states.on' : 'permissions.states.off')
  : t(`permissions.states.${value}`);
export const scopePermissions = (scope: AccessScope | null): readonly AccessPermission[] => {
  if (scope === null) return [];
  switch (scope.kind) {
  case 'upstreamModel': return ['Model.Use'];
  case 'upstreams':
  case 'upstream': return ['Model.Use', 'Upstream.Audit', 'Upstream.Edit'];
  case 'self':
  case 'groups': return ['Permission.Audit'];
  case 'users':
  case 'user':
  case 'group': return ['User.Audit', 'Permission.Audit'];
  }
};
export const filterScopeValues = (scope: AccessScope | null, values: AccessValues): AccessValues => {
  const allowed = scopePermissions(scope);
  return Object.fromEntries(Object.entries(values).filter(([permission]) => allowed.includes(permission as AccessPermission))) as AccessValues;
};
