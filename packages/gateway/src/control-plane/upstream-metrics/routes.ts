import { checkMany } from '../../access-control/check.ts';
import { metricDisplayResolverForKind } from '../../data-plane/providers/registry.ts';
import { userFromContext, type AuthedContext } from '../../middleware/auth.ts';
import type { CtxWithQuery } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import type { upstreamMetricsQuery, upstreamResetCyclesQuery } from '../schemas.ts';
import type { UpstreamMetricDisplay, UpstreamMetricIdentity } from '@floway-dev/provider';

const auditableUpstream = async (c: AuthedContext, upstreamId: string) => {
  const [allowed] = await checkMany(userFromContext(c), [{
    target: { kind: 'upstream', upstreamId },
    requirement: { permission: 'Upstream.Audit' },
  }]);
  return allowed ? await getRepo().upstreams.getById(upstreamId) : null;
};

export const upstreamMetrics = async (c: CtxWithQuery<typeof upstreamMetricsQuery>) => {
  const { upstream_id, start, end, step } = c.req.valid('query');
  if (!await auditableUpstream(c, upstream_id)) return c.json({ error: 'Upstream not found' }, 404);
  return c.json({ records: await getRepo().upstreamMetrics.query(upstream_id, start, end, step), start, end, step });
};

interface ResetCycles {
  upstreamId: string;
  supported: boolean;
  metrics: Array<{
    identity: UpstreamMetricIdentity;
    display: Pick<UpstreamMetricDisplay, 'name' | 'labelKey' | 'labelValues' | 'windowSeconds'>;
    starts: number[];
  }>;
}

export const upstreamResetCycles = async (c: CtxWithQuery<typeof upstreamResetCyclesQuery>) => {
  const { upstream_id, before } = c.req.valid('query');
  const upstream = await auditableUpstream(c, upstream_id);
  const resolve = upstream === null ? undefined : metricDisplayResolverForKind(upstream.kind);
  // A filter that is unavailable must not distinguish a missing upstream
  // from one that the operator cannot audit.
  if (resolve === undefined) return c.json<ResetCycles>({ upstreamId: upstream_id, supported: false, metrics: [] });
  const repo = getRepo().upstreamMetrics;
  const identities = await repo.listIdentities(upstream_id, before);
  const metrics = await Promise.all(identities.flatMap(identity => {
    const display = resolve(identity, { quotaDisplay: 'remaining' });
    if (display?.resetThreshold === undefined) return [];
    const { name, labelKey, labelValues, windowSeconds, resetThreshold } = display;
    return [repo.queryResetStarts(upstream_id, identity, resetThreshold, before).then(starts => ({
      identity, display: { name, labelKey, labelValues, windowSeconds }, starts,
    }))];
  }));
  return c.json<ResetCycles>({ upstreamId: upstream_id, supported: true, metrics });
};
