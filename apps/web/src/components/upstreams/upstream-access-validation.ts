import type { z } from 'zod';

// The switch that opens the picker and the picker itself are one control, so
// the rule that an opened picker must name at least one upstream belongs to the
// control rather than to each form that mounts it.
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
