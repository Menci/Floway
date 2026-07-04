import type { Context } from 'hono';

import { createPerRequestFetcher } from '../../dial/per-request.ts';
import { getRepo } from '../../repo/index.ts';
import { getCurrentColo } from '../../runtime/runtime-info.ts';
import {
  assertCursorUpstreamState,
  CursorDashboardSessionExpiredError,
  CursorDashboardUpstreamError,
  CursorSessionTerminatedError,
  ensureCursorAccessToken,
  fetchCursorDashboardUsage,
  mintCursorAccessToken,
  type CursorUpstreamState,
} from '@floway-dev/provider-cursor';

// GET /api/upstreams/:id/cursor/quota — on-demand fetch of the current
// billing-cycle usage from cursor.com/dashboard/spending's endpoint. Mirrors
// the copilot-quota shape (control-plane pull, no persistence). See
// packages/provider-cursor/src/quota.ts for the fetcher + error taxonomy.
export const cursorQuota = async (c: Context) => {
  try {
    const id = c.req.param('id')!;
    const upstream = await getRepo().upstreams.getById(id);
    if (upstream?.kind !== 'cursor') {
      return c.json({ error: 'Cursor upstream not found' }, 404);
    }
    assertCursorUpstreamState(upstream.state);
    const account = upstream.state.accounts[0]!;
    if (account.state !== 'active') {
      return c.json({ error: `Cursor upstream is ${account.state}; re-import to recover` }, 400);
    }

    const fetcherForUpstream = await createPerRequestFetcher(getCurrentColo(c.req.raw));
    const fetcher = fetcherForUpstream(upstream.id);

    // Rotated-refresh-token persistence hook for ensureCursorAccessToken.
    // Re-reads state before writing so we don't clobber a racing update.
    const persistRefreshTokenRotation = async (newRefreshToken: string): Promise<void> => {
      const fresh = await getRepo().upstreams.getById(id);
      if (fresh?.kind !== 'cursor') return;
      assertCursorUpstreamState(fresh.state);
      const nextState: CursorUpstreamState = {
        ...fresh.state,
        accounts: fresh.state.accounts.map(a =>
          a.userId === account.userId
            ? { ...a, refresh_token: newRefreshToken, state_updated_at: new Date().toISOString() }
            : a),
      };
      await getRepo().upstreams.saveState(id, nextState, { expectedState: fresh.state });
    };

    let entry;
    try {
      entry = await ensureCursorAccessToken(id, account.userId, refresh =>
        mintCursorAccessToken(refresh, fetcher, persistRefreshTokenRotation));
    } catch (err) {
      // A dead refresh_token surfaces here; the account flip to refresh_failed
      // is owned by the data-plane's persistTerminalState (fetch.ts). Map to
      // 502 (not 401 — the frontend authFetch treats 401 as *our* session
      // expiring and force-logs-out) with a machine-readable `kind` field so
      // the panel can render a re-import hint.
      if (err instanceof CursorSessionTerminatedError) {
        return c.json(
          {
            error: `Cursor refresh failed: ${err.upstreamMessage}. Re-import the credential to recover.`,
            kind: 'session_expired' as const,
          },
          502,
        );
      }
      throw err;
    }

    try {
      const usage = await fetchCursorDashboardUsage({ userId: account.userId, accessToken: entry.token, fetcher });
      return c.json(usage);
    } catch (err) {
      if (err instanceof CursorDashboardSessionExpiredError) {
        return c.json({ error: err.message, kind: 'session_expired' as const }, 502);
      }
      if (err instanceof CursorDashboardUpstreamError) {
        return c.json({ error: err.message }, 502);
      }
      throw err;
    }
  } catch (e: unknown) {
    console.error('Failed to fetch Cursor dashboard usage:', e);
    return c.json({ error: 'Failed to fetch Cursor dashboard usage' }, 502);
  }
};
