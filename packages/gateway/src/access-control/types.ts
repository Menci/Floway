export type AccessPrincipal =
  | { kind: 'user'; id: number }
  | { kind: 'group'; id: number };

export type ModelPattern =
  | { kind: 'exact'; value: string }
  | { kind: 'regex'; value: string };

export type AccessScope =
  | { kind: 'upstreams' }
  | { kind: 'upstream'; upstreamId: string }
  | { kind: 'upstreamModel'; upstreamId: string; model: ModelPattern }
  | { kind: 'users' }
  | { kind: 'user'; userId: number }
  | { kind: 'group'; groupId: number };

export type AccessTarget =
  | { kind: 'upstream'; upstreamId: string }
  | { kind: 'upstreamModel'; upstreamId: string; modelId: string }
  | { kind: 'user'; userId: number };

export type AccessPermission = 'Model.Use' | 'Upstream.Audit' | 'Upstream.Edit' | 'User.Audit';
export type UpstreamEditLevel = 'off' | 'models' | 'full';

export interface AccessValues {
  'Model.Use'?: boolean;
  'Upstream.Audit'?: boolean;
  'Upstream.Edit'?: UpstreamEditLevel;
  'User.Audit'?: boolean;
}

export interface AccessRecord {
  id: number;
  principal: AccessPrincipal;
  scope: AccessScope;
  sortOrder: number;
  values: AccessValues;
  createdAt: string;
  updatedAt: string;
}

export interface AccessRecordInput {
  principal: AccessPrincipal;
  scope: AccessScope;
  sortOrder: number;
  values: AccessValues;
}

export type PermissionDecision = { kind: 'effective' } | { kind: 'overridden'; by: AccessRecord };
export type PermissionDecisions = Partial<Record<AccessPermission, PermissionDecision>>;

export interface AccessResolution {
  values: AccessValues;
  records: AccessRecord[];
  decisions: Array<{ recordId: number; permissions: PermissionDecisions }>;
}

export class AccessRecordConflictError extends Error {
  override name = 'AccessRecordConflictError';
}

export const sameModelOrderBoundary = (left: AccessRecordInput, right: AccessRecordInput): boolean =>
  left.scope.kind === 'upstreamModel' && right.scope.kind === 'upstreamModel'
  && left.scope.upstreamId === right.scope.upstreamId
  && left.principal.kind === right.principal.kind && left.principal.id === right.principal.id;

export type AccessRequirement =
  | { permission: 'Model.Use' | 'Upstream.Audit' | 'User.Audit' }
  | { permission: 'Upstream.Edit'; level: Exclude<UpstreamEditLevel, 'off'> };

export interface AccessCheck {
  target: AccessTarget;
  requirement: AccessRequirement;
}

export const accessScopeDepth = (scope: AccessScope): number => {
  switch (scope.kind) {
  case 'upstreams':
  case 'users': return 1;
  case 'upstream':
  case 'user':
  case 'group': return 2;
  case 'upstreamModel': return 3;
  }
};

export const accessScopeOrderGroup = (scope: AccessScope): string => {
  switch (scope.kind) {
  case 'upstreams':
  case 'upstream': return 'upstream';
  case 'upstreamModel': return `upstream:${scope.upstreamId}`;
  case 'users':
  case 'user':
  case 'group': return 'user';
  }
};

export const permissionsForScope = (scope: AccessScope): readonly AccessPermission[] => {
  switch (scope.kind) {
  case 'upstreams':
  case 'upstream': return ['Model.Use', 'Upstream.Audit', 'Upstream.Edit'];
  case 'upstreamModel': return ['Model.Use'];
  case 'users':
  case 'user':
  case 'group': return ['User.Audit'];
  }
};

export const validateAccessRecordInput = (input: AccessRecordInput): void => {
  if (!Number.isInteger(input.sortOrder) || input.sortOrder < 0) {
    throw new Error('Access record sortOrder must be a nonnegative integer');
  }
  const allowed = new Set<AccessPermission>(permissionsForScope(input.scope));
  const entries = Object.entries(input.values) as Array<[AccessPermission, unknown]>;
  if (entries.length === 0) throw new Error('Access record must set at least one permission');
  for (const [permission, value] of entries) {
    if (!allowed.has(permission)) throw new Error(`${permission} is not valid for ${input.scope.kind}`);
    if (permission === 'Upstream.Edit') {
      if (value !== 'off' && value !== 'models' && value !== 'full') {
        throw new Error('Upstream.Edit must be off, models, or full');
      }
    } else if (typeof value !== 'boolean') {
      throw new Error(`${permission} must be a boolean`);
    }
  }
  if (input.scope.kind === 'upstreamModel') {
    if (input.scope.model.value.length === 0) throw new Error('Model pattern must not be empty');
    if (input.scope.model.kind === 'regex') new RegExp(input.scope.model.value);
  }
};
