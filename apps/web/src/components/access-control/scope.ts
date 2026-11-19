import { z } from 'zod';

import type { ScopeExpressionData } from './scope-expression';
import type { AccessScope } from '@floway-dev/gateway/browser';

const modelPatternSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('exact'), value: z.string().min(1) }),
  z.object({ kind: z.literal('regex'), value: z.string().min(1) }).superRefine((value, context) => {
    try { new RegExp(value.value); } catch (cause) { context.addIssue({ code: 'custom', message: cause instanceof Error ? cause.message : String(cause) }); }
  }),
]);
export const scopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('self') }),
  z.object({ kind: z.literal('upstreams') }),
  z.object({ kind: z.literal('upstream'), upstreamId: z.string().min(1) }),
  z.object({ kind: z.literal('upstreamModel'), upstreamId: z.string().min(1), model: modelPatternSchema }),
  z.object({ kind: z.literal('users') }),
  z.object({ kind: z.literal('user'), userId: z.number().int().positive() }),
  z.object({ kind: z.literal('groups') }),
  z.object({ kind: z.literal('group'), groupId: z.number().int().positive() }),
]);

export const parseScope = (value: string | null): AccessScope | null => value === null ? null : scopeSchema.parse(JSON.parse(value));
export const scopeDepth = (scope: AccessScope) => scope.kind === 'self' ? 4 : scope.kind === 'upstreamModel' ? 3
  : scope.kind === 'upstreams' || scope.kind === 'users' || scope.kind === 'groups' ? 1 : 2;
export const scopeKey = (scope: AccessScope): string => {
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

export const scopeContains = (outer: AccessScope | null, inner: AccessScope, data: Pick<ScopeExpressionData, 'groups'>): boolean => {
  if (outer === null || scopeKey(outer) === scopeKey(inner)) return true;
  if (outer.kind === 'upstreams') return inner.kind === 'upstream' || inner.kind === 'upstreamModel';
  if (outer.kind === 'upstream') return inner.kind === 'upstreamModel' && outer.upstreamId === inner.upstreamId;
  if (outer.kind === 'upstreamModel') return outer.model.kind === 'regex' && inner.kind === 'upstreamModel'
    && inner.model.kind === 'exact' && inner.upstreamId === outer.upstreamId && new RegExp(outer.model.value).test(inner.model.value);
  if (outer.kind === 'users') return inner.kind === 'user';
  if (outer.kind === 'groups') return inner.kind === 'group';
  if (outer.kind === 'group' && inner.kind === 'user') return data.groups.some(group => group.id === outer.groupId && group.memberIds.includes(inner.userId));
  return false;
};
