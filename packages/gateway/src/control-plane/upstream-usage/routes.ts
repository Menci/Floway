import type { CtxWithQuery } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import type { upstreamUsageQuery } from '../schemas.ts';

export const upstreamUsage = async (c: CtxWithQuery<typeof upstreamUsageQuery>) => {
  const { start, end } = c.req.valid('query');
  return c.json({ records: await getRepo().upstreamUsageMetrics.query(start, end), start, end });
};
