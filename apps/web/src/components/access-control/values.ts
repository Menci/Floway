import type { TFunction } from '../../i18n/translation';
import type { BadgeTone } from '../ui/status-badge';
import type { AccessPermission, AccessScope, AccessValues } from '@floway-dev/gateway/browser';

export const ACCESS_PERMISSIONS: readonly AccessPermission[] = ['Model.Use', 'Upstream.Audit', 'Upstream.Edit', 'User.Audit'];
export type PermissionState = 'on' | 'off' | 'models' | 'full';
export const permissionState = (value: NonNullable<AccessValues[AccessPermission]>): PermissionState => typeof value === 'boolean' ? value ? 'on' : 'off' : value;
export const permissionTone = (value: NonNullable<AccessValues[AccessPermission]>): BadgeTone => value === 'models'
  ? 'accent' : value === true || value === 'full' ? 'success' : 'neutral';
export const permissionValueLabel = (value: NonNullable<AccessValues[AccessPermission]>, t: TFunction): string => typeof value === 'boolean'
  ? t(value ? 'dashboard.accessControl.states.on' : 'dashboard.accessControl.states.off')
  : t(`dashboard.accessControl.states.${value}`);
export const scopePermissions = (scope: AccessScope): readonly AccessPermission[] => scope.kind === 'upstreamModel'
  ? ['Model.Use'] : scope.kind === 'upstreams' || scope.kind === 'upstream'
      ? ['Model.Use', 'Upstream.Audit', 'Upstream.Edit'] : ['User.Audit'];
