import { checkMany } from '../../access-control/check.ts';
import { userFromContext } from '../../middleware/auth.ts';
import type { CtxWithQuery } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import type { upstreamMetricsQuery } from '../schemas.ts';

export const upstreamMetrics = async (c: CtxWithQuery<typeof upstreamMetricsQuery>) => {
  const { upstream_id, start, end, step } = c.req.valid('query');
  const [allowed] = await checkMany(userFromContext(c), [{
    target: { kind: 'upstream', upstreamId: upstream_id },
    requirement: { permission: 'Upstream.Audit' },
  }]);
  if (!allowed) return c.json({ error: 'Upstream not found' }, 404);
  if (!await getRepo().upstreams.getById(upstream_id)) return c.json({ error: 'Upstream not found' }, 404);
  return c.json({ records: await getRepo().upstreamMetrics.query(upstream_id, start, end, step), start, end, step });
};
