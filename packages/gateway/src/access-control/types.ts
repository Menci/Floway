export type AccessPrincipal =
  | { kind: 'user'; id: number }
  | { kind: 'group'; id: number };

export type ModelPattern =
  | { kind: 'exact'; value: string }
  | { kind: 'regex'; value: string };

export type AccessScope =
  | { kind: 'self' }
  | { kind: 'upstreams' }
  | { kind: 'upstream'; upstreamId: string }
  | { kind: 'upstreamModel'; upstreamId: string; model: ModelPattern }
  | { kind: 'users' }
  | { kind: 'user'; userId: number }
  | { kind: 'groups' }
  | { kind: 'group'; groupId: number };

export type ResolveScope = Exclude<AccessScope, { kind: 'self' }>;

export type AccessTarget = Extract<ResolveScope, { kind: 'upstream' | 'upstreamModel' | 'user' | 'group' }>;

export interface AccessEvaluation {
  targetGroups: ReadonlySet<number>;
  subjectUserId?: number;
}

export type AccessPermission = 'Model.Use' | 'Upstream.Audit' | 'Upstream.Edit' | 'User.Audit' | 'Permission.Audit';
export type UpstreamEditLevel = 'off' | 'models' | 'full';
export const upstreamEditLevelRank: Record<UpstreamEditLevel, number> = { off: 0, models: 1, full: 2 };

// Membership scopes describe their members as users; only user-audit follows
// that relation. Permission-audit on a group audits the group itself.
export const groupRuleAppliesToMembers: Record<AccessPermission, boolean> = {
  'Model.Use': false,
  'Upstream.Audit': false,
  'Upstream.Edit': false,
  'User.Audit': true,
  'Permission.Audit': false,
};

export interface AccessValues {
  'Model.Use'?: boolean;
  'Upstream.Audit'?: boolean;
  'Upstream.Edit'?: UpstreamEditLevel;
  'User.Audit'?: boolean;
  'Permission.Audit'?: boolean;
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
  | { permission: Exclude<AccessPermission, 'Upstream.Edit'> }
  | { permission: 'Upstream.Edit'; level: Exclude<UpstreamEditLevel, 'off'> };

export interface AccessCheck {
  target: AccessTarget;
  requirement: AccessRequirement;
}

export const accessScopeKey = (scope: AccessScope): string => {
  switch (scope.kind) {
  case 'upstream': return JSON.stringify([scope.kind, scope.upstreamId]);
  case 'upstreamModel': return JSON.stringify([scope.kind, scope.upstreamId, scope.model.kind, scope.model.value]);
  case 'user': return JSON.stringify([scope.kind, scope.userId]);
  case 'group': return JSON.stringify([scope.kind, scope.groupId]);
  case 'self':
  case 'upstreams':
  case 'users':
  case 'groups': return scope.kind;
  }
};

export const canonicalAccessScope = (scope: AccessScope): AccessScope => {
  switch (scope.kind) {
  case 'upstream': return { kind: scope.kind, upstreamId: scope.upstreamId };
  case 'upstreamModel': return { kind: scope.kind, upstreamId: scope.upstreamId, model: { kind: scope.model.kind, value: scope.model.value } };
  case 'user': return { kind: scope.kind, userId: scope.userId };
  case 'group': return { kind: scope.kind, groupId: scope.groupId };
  case 'self':
  case 'upstreams':
  case 'users':
  case 'groups': return { kind: scope.kind };
  }
};

export const accessScopeDepth = (scope: AccessScope): number => {
  switch (scope.kind) {
  case 'self': return 4;
  case 'upstreams':
  case 'users':
  case 'groups': return 1;
  case 'upstream':
  case 'user':
  case 'group': return 2;
  case 'upstreamModel': return 3;
  }
};

export const accessScopeOrderGroup = (scope: AccessScope): string => {
  switch (scope.kind) {
  case 'self': return 'self';
  case 'upstreams':
  case 'upstream': return 'upstream';
  case 'upstreamModel': return `upstream:${scope.upstreamId}`;
  case 'users':
  case 'user': return 'user';
  case 'groups':
  case 'group': return 'group';
  }
};

export const permissionsForScope = (scope: AccessScope): readonly AccessPermission[] => {
  switch (scope.kind) {
  case 'self': return ['Permission.Audit'];
  case 'upstreams':
  case 'upstream': return ['Model.Use', 'Upstream.Audit', 'Upstream.Edit'];
  case 'upstreamModel': return ['Model.Use'];
  case 'users':
  case 'user':
  case 'group': return ['User.Audit', 'Permission.Audit'];
  case 'groups': return ['Permission.Audit'];
  }
};

export const administratorAccessValues = (scope: AccessScope): AccessValues =>
  Object.fromEntries(permissionsForScope(scope).map(permission => [permission, permission === 'Upstream.Edit' ? 'full' : true]));

export const accessValueSatisfied = (
  value: AccessValues[AccessPermission] | undefined,
  requirement: AccessRequirement,
): boolean => {
  if (value === undefined) return false;
  return requirement.permission === 'Upstream.Edit'
    ? upstreamEditLevelRank[value as UpstreamEditLevel] >= upstreamEditLevelRank[requirement.level]
    : value === true;
};

export const accessRequirementSatisfied = (values: AccessValues, requirement: AccessRequirement): boolean =>
  accessValueSatisfied(values[requirement.permission], requirement);

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
