import type { z } from 'zod';

// The switch and the picker it opens are one control, so this rule belongs to
// the control rather than to each form that mounts it.
export interface UpstreamAccessValues {
  upstreamOverride: boolean;
  upstreamIds: string[];
}

export const refineUpstreamAccess = (value: UpstreamAccessValues, ctx: z.RefinementCtx) => {
  if (value.upstreamOverride && value.upstreamIds.length === 0) {
    ctx.addIssue({
      code: 'custom',
      message: 'dashboard.upstreamAccess.validation',
      path: ['upstreamIds'],
    });
  }
};
