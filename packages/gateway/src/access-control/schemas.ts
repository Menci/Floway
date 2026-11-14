import { z } from 'zod';

import { type AccessRecordInput, validateAccessRecordInput } from './types.ts';

const positiveInteger = z.number().int().positive();

export const accessPrincipalSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user'), id: positiveInteger }),
  z.object({ kind: z.literal('group'), id: positiveInteger }),
]);

export const modelPatternSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('exact'), value: z.string().min(1) }),
  z.object({ kind: z.literal('regex'), value: z.string().min(1) }),
]);

export const accessScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('self') }),
  z.object({ kind: z.literal('upstreams') }),
  z.object({ kind: z.literal('upstream'), upstreamId: z.string().min(1) }),
  z.object({ kind: z.literal('upstreamModel'), upstreamId: z.string().min(1), model: modelPatternSchema }),
  z.object({ kind: z.literal('users') }),
  z.object({ kind: z.literal('user'), userId: positiveInteger }),
  z.object({ kind: z.literal('groups') }),
  z.object({ kind: z.literal('group'), groupId: positiveInteger }),
]);

export const accessTargetScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('upstreams') }),
  z.object({ kind: z.literal('upstream'), upstreamId: z.string().min(1) }),
  z.object({ kind: z.literal('upstreamModel'), upstreamId: z.string().min(1), model: modelPatternSchema }),
  z.object({ kind: z.literal('users') }),
  z.object({ kind: z.literal('user'), userId: positiveInteger }),
  z.object({ kind: z.literal('groups') }),
  z.object({ kind: z.literal('group'), groupId: positiveInteger }),
]);

export const accessValuesSchema = z.object({
  'Model.Use': z.boolean().optional(),
  'Upstream.Audit': z.boolean().optional(),
  'Upstream.Edit': z.enum(['off', 'models', 'full']).optional(),
  'User.Audit': z.boolean().optional(),
  'Permission.Audit': z.boolean().optional(),
}).strict();

export const accessRecordInputSchema = z.object({
  principal: accessPrincipalSchema,
  scope: accessScopeSchema,
  sortOrder: z.number().int().nonnegative(),
  values: accessValuesSchema,
}).strict().superRefine((record, context) => {
  try {
    validateAccessRecordInput(record as AccessRecordInput);
  } catch (cause) {
    context.addIssue({ code: 'custom', message: cause instanceof Error ? cause.message : String(cause) });
  }
});
