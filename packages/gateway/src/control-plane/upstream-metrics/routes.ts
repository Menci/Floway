import { checkMany } from '../../access-control/check.ts';
import { metricDisplayResolverForKind } from '../../data-plane/upstreams/registry.ts';
import { userFromContext, type AuthedContext } from '../../middleware/auth.ts';
import type { CtxWithQuery } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import type { upstreamMetricsQuery, upstreamResetCyclesQuery } from '../schemas.ts';
import { normalizeUpstreamMetricIdentity, type UpstreamMetricDisplay, type UpstreamMetricIdentity } from '@floway-dev/upstream';

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
    hasMore?: true;
  }>;
  cycle?: {
    start: number;
    end: number | null;
    quota?: { amount: number; unit: 'usd' | 'count' | 'credits' };
  };
}

const RESET_CYCLE_PAGE_SIZE = 24;

const parseCycleMetric = (value: string): UpstreamMetricIdentity | null => {
  try {
    const parts: unknown = JSON.parse(value);
    return Array.isArray(parts) && parts.length === 2 ? normalizeUpstreamMetricIdentity(parts[0], parts[1]) : null;
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError) return null;
    throw error;
  }
};

export const upstreamResetCycles = async (c: CtxWithQuery<typeof upstreamResetCyclesQuery>) => {
  const { upstream_id, before, after, view, cycle_metric, cycle_start, current } = c.req.valid('query');
  const upstream = await auditableUpstream(c, upstream_id);
  const resolve = upstream === undefined ? undefined : metricDisplayResolverForKind(upstream.kind);
  const response: ResetCycles = { upstreamId: upstream_id, supported: resolve !== undefined, metrics: [] };
  // A filter that is unavailable must not distinguish a missing upstream
  // from one that the operator cannot audit.
  if (resolve === undefined || view === 'availability') return c.json(response);

  const repo = getRepo();
  const selectedMetric = cycle_metric === undefined ? undefined : parseCycleMetric(cycle_metric);
  if (selectedMetric === null) return c.json({ error: 'Invalid cycle metric identity' }, 400);
  const identities = selectedMetric === undefined ? await repo.upstreamMetrics.listIdentities(upstream_id, before) : [selectedMetric];
  const metrics = identities.flatMap(identity => {
    const display = resolve(identity, { quotaDisplay: 'remaining' });
    if (display?.resetThreshold === undefined) return [];
    return [{ identity, display, resetThreshold: display.resetThreshold }];
  });

  if (view === 'history' || cycle_metric === undefined) {
    response.metrics = await Promise.all(metrics.map(async ({ identity, display, resetThreshold }) => {
      const { name, labelKey, labelValues, windowSeconds } = display;
      const starts = await repo.upstreamMetrics.queryResetStarts(upstream_id, identity, resetThreshold, before, {
        ...(after === undefined ? {} : { from: after + 1, order: 'asc' }),
        limit: RESET_CYCLE_PAGE_SIZE + 1,
      });
      const page = starts.slice(0, RESET_CYCLE_PAGE_SIZE).map(({ timestamp }) => timestamp);
      return {
        identity, display: { name, labelKey, ...(labelValues === undefined ? {} : { labelValues }), windowSeconds },
        starts: after === undefined ? page : page.reverse(), ...(starts.length > RESET_CYCLE_PAGE_SIZE && { hasMore: true as const }),
      };
    }));
    return c.json(response);
  }

  const [metric] = metrics;
  if (metric === undefined) return c.json(response);
  const { identity, display, resetThreshold } = metric;
  const historical = cycle_start !== undefined && current === undefined;
  const [start, next] = await repo.upstreamMetrics.queryResetStarts(upstream_id, identity, resetThreshold, before, {
    from: cycle_start, order: historical ? 'asc' : 'desc', limit: historical ? 2 : 1,
  });
  if (start === undefined || (historical && (start.timestamp !== cycle_start || next === undefined))) return c.json(response);
  response.cycle = { start: start.timestamp, end: next?.timestamp ?? null };
  if (typeof resetThreshold.full !== 'number') {
    const { unit, toDisplayValue } = display;
    if (unit !== 'usd' && unit !== 'count' && unit !== 'credits') throw new TypeError('An absolute quota must have an absolute unit');
    response.cycle.quota = { amount: toDisplayValue(start.value), unit };
  }
  return c.json(response);
};
