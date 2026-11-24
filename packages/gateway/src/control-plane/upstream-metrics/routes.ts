import { estimateCycleQuota, type CycleQuota } from './cycle-quota.ts';
import { checkMany } from '../../access-control/check.ts';
import { metricDisplayResolverForKind } from '../../data-plane/providers/registry.ts';
import { userFromContext, type AuthedContext } from '../../middleware/auth.ts';
import type { CtxWithQuery } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import type { upstreamMetricsQuery, upstreamResetCyclesQuery } from '../schemas.ts';
import { upstreamMetricIdentityKey, type UpstreamMetricDisplay, type UpstreamMetricIdentity } from '@floway-dev/provider';

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
  quota?: CycleQuota;
}

export const upstreamResetCycles = async (c: CtxWithQuery<typeof upstreamResetCyclesQuery>) => {
  const { upstream_id, before, cycle_metric, cycle_start } = c.req.valid('query');
  const upstream = await auditableUpstream(c, upstream_id);
  const resolve = upstream === null ? undefined : metricDisplayResolverForKind(upstream.kind);
  // A filter that is unavailable must not distinguish a missing upstream
  // from one that the operator cannot audit.
  if (resolve === undefined) return c.json<ResetCycles>({ upstreamId: upstream_id, supported: false, metrics: [] });
  const repo = getRepo();
  const identities = await repo.upstreamMetrics.listIdentities(upstream_id, before);
  const metrics = await Promise.all(identities.flatMap(identity => {
    const display = resolve(identity, { quotaDisplay: 'remaining' });
    if (display?.resetThreshold === undefined) return [];
    const { name, labelKey, labelValues, windowSeconds, resetThreshold } = display;
    return [repo.upstreamMetrics.queryResetStarts(upstream_id, identity, resetThreshold, before).then(starts => ({
      identity, display: { name, labelKey, labelValues, windowSeconds }, starts,
    }))];
  }));
  const selection = cycle_metric === undefined ? undefined : metrics.find(metric => upstreamMetricIdentityKey(metric.identity) === cycle_metric);
  const offset = cycle_start === undefined ? 0 : selection?.starts.indexOf(cycle_start) ?? -1;
  if (selection !== undefined && (cycle_start === undefined || offset > 0)) {
    const start = selection.starts[offset];
    const display = resolve(selection.identity, { quotaDisplay: 'used' });
    if (start !== undefined && display !== null) {
      const quota = await estimateCycleQuota(repo, upstream_id, selection.identity, display,
        { start, next: offset === 0 ? null : selection.starts[offset - 1]!, before });
      return c.json<ResetCycles>({ upstreamId: upstream_id, supported: true, metrics, quota });
    }
  }
  return c.json<ResetCycles>({ upstreamId: upstream_id, supported: true, metrics });
};
