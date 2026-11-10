import type { UpstreamResetCyclesResponse } from './types.ts';
import { checkMany } from '../../access-control/check.ts';
import { resetMetricForKind } from '../../data-plane/providers/registry.ts';
import { userFromContext } from '../../middleware/auth.ts';
import type { CtxWithQuery } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import type { upstreamMetricsQuery, upstreamResetCyclesQuery } from '../schemas.ts';

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

export const upstreamResetCycles = async (c: CtxWithQuery<typeof upstreamResetCyclesQuery>) => {
  const { upstream_id, end } = c.req.valid('query');
  const [allowed] = await checkMany(userFromContext(c), [{
    target: { kind: 'upstream', upstreamId: upstream_id },
    requirement: { permission: 'Upstream.Audit' },
  }]);
  // Availability does not reveal whether an unauditable upstream exists.
  if (!allowed) return c.json<UpstreamResetCyclesResponse>({ upstreamId: upstream_id, available: false, metrics: [] });
  const repo = getRepo();
  const upstream = await repo.upstreams.getById(upstream_id);
  if (upstream === null) return c.json<UpstreamResetCyclesResponse>({ upstreamId: upstream_id, available: false, metrics: [] });
  const identities = await repo.upstreamMetrics.listIdentities(upstream_id, end);
  const metrics = await Promise.all(identities.flatMap(identity => {
    const display = resetMetricForKind(upstream.kind, identity);
    if (display === null) return [];
    const { resetValue, ...label } = display;
    return [repo.upstreamMetrics.queryResetStarts(upstream_id, identity, resetValue, end).then(starts => ({
      identity, display: label, currentStart: starts[0] ?? null, previousStart: starts[1] ?? null,
    }))];
  }));
  return c.json<UpstreamResetCyclesResponse>({ upstreamId: upstream_id, available: true, metrics });
};
