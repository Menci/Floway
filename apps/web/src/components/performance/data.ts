import {
  buildPerformanceQuery,
  parsePerformanceUrlState,
  type PerformanceOverviewResponse,
  type PerformanceUrlState,
  type PerformanceView,
} from './overview';
import type { AuthUser } from '../../api/auth';
import { api, callApi, type GlobalError } from '../../api/client';
import { scopeTelemetryIdentity } from '../telemetry/filter-state';

interface UpstreamName { id: string; name: string }

export interface PerformancePageData {
  currentUserId: string;
  error: GlobalError | null;
  loadedAt: number;
  // `null` is a failed fetch, not a quiet gateway: an empty overview would
  // render zeroes the page does not know to be true.
  overview: PerformanceOverviewResponse | null;
  state: PerformanceUrlState;
  // Null on the same terms: without the names, a group labels itself with an
  // upstream id the page would be presenting as a name.
  upstreamNames: UpstreamName[] | null;
  view: PerformanceView;
}

export const loadPerformancePageData = async (
  request: Request,
  user: AuthUser,
): Promise<PerformancePageData> => {
  const state = parsePerformanceUrlState(new URL(request.url).searchParams);
  const view: PerformanceView = user.isAdmin ? 'all-by-user' : 'self-by-key';
  const scoped = scopeTelemetryIdentity(state.groupBy, state.filters, {
    currentUserId: String(user.id),
    fallbackGroup: 'model',
    userDimensionAvailable: view === 'all-by-user',
  });
  const loadedAt = Date.now();
  const query = buildPerformanceQuery(state.range, scoped.groupBy, scoped.filters, loadedAt);
  // The page opens for every signed-in account, so the names come from the
  // non-admin upstream picker; /api/upstreams answers 403 to an operator and
  // would leave the whole page unavailable to them.
  const [overview, upstreams] = await Promise.all([
    callApi(() => api.api.performance.overview.$get({ query }, { init: { signal: request.signal } })),
    callApi(() => api.api['upstream-options'].$get({}, { init: { signal: request.signal } })),
  ]);
  return {
    currentUserId: String(user.id),
    error: overview.error ?? upstreams.error ?? null,
    loadedAt,
    overview: overview.data ?? null,
    state: { ...state, ...scoped },
    upstreamNames: upstreams.data?.map(({ id, name }) => ({ id, name })) ?? null,
    view,
  };
};
