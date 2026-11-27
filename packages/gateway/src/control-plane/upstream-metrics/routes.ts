import { estimateCycleQuota, type CycleQuota } from './cycle-quota.ts';
import { checkMany } from '../../access-control/check.ts';
import { metricDisplayResolverForKind } from '../../data-plane/upstreams/registry.ts';
import { userFromContext, type AuthedContext } from '../../middleware/auth.ts';
import type { CtxWithQuery } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import type { upstreamMetricsQuery, upstreamResetCyclesQuery } from '../schemas.ts';
import { upstreamMetricIdentityKey, type UpstreamMetricDisplay, type UpstreamMetricIdentity } from '@floway-dev/upstream';

const auditableUpstream = async (c: AuthedContext, upstreamId: string) => {
  const [allowed] = await checkMany(userFromContext(c), [{
    target: { kind: 'upstream', upstreamId },
    requirement: { permission: 'Upstream.Audit' },
  }]);
  if (!allowed) return undefined;
  const [upstream] = await getRepo().upstreams.getMetaByIds([upstreamId]);
  return upstream;
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
  const resolve = upstream === undefined ? undefined : metricDisplayResolverForKind(upstream.kind);
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
      identity, display: { name, labelKey, ...(labelValues === undefined ? {} : { labelValues }), windowSeconds }, starts,
    }))];
  }));
  const data = { upstreamId: upstream_id, supported: true, metrics };
  const selected = cycle_metric === undefined ? undefined
    : metrics.find(metric => upstreamMetricIdentityKey(metric.identity) === cycle_metric);
  if (selected === undefined) return c.json<ResetCycles>(data);
  const offset = cycle_start === undefined ? 0 : selected.starts.indexOf(cycle_start);
  const start = selected.starts[offset];
  if (start === undefined || (cycle_start !== undefined && offset === 0)) return c.json<ResetCycles>(data);
  const display = resolve(selected.identity, { quotaDisplay: 'used' });
  if (display === null) throw new Error('Missing display for selected quota metric');
  const quota = await estimateCycleQuota(repo, upstream_id, selected.identity, display,
    { start, next: selected.starts[offset - 1] ?? null, before });
  return c.json<ResetCycles>({ ...data, quota });
};
