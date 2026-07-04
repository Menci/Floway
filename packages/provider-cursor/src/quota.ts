/**
 * Cursor subscription usage fetch.
 *
 * `POST cursor.com/api/dashboard/get-current-period-usage` is the same
 * endpoint the browser dashboard's Spending tab uses — it validates the
 * WorkOS session cookie (`WorkosCursorSessionToken=${userId}::${jwt}`) and
 * returns the current cycle's spend, per-bucket percentages, and the cycle
 * end. Called on-demand by the control-plane cursor-quota route (mirrors the
 * copilot-quota shape); result is not persisted.
 */

import type { Fetcher } from '@floway-dev/provider';

// Subscription usage — cursor.com dashboard endpoint

export const CURSOR_DASHBOARD_USAGE_URL = 'https://cursor.com/api/dashboard/get-current-period-usage';

// The dashboard endpoint rejects non-browser-shaped requests with
// `Invalid origin for state-changing request`. Origin + Referer must match a
// cursor.com surface; the User-Agent must look like a real browser. Kept here
// (not in constants.ts) so this endpoint's requirements stay next to the code
// that sends them.
const CURSOR_DASHBOARD_ORIGIN = 'https://cursor.com';
const CURSOR_DASHBOARD_REFERER = 'https://cursor.com/dashboard/spending';
const CURSOR_DASHBOARD_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

/**
 * One current-billing-cycle usage snapshot from cursor.com/dashboard/spending.
 *
 * `limitCents` is the plan ceiling. Cursor omits it for cycles with no plan
 * assigned; the field is null in that case.
 *
 * The three `*PercentUsed` fields mirror the three bars the Cursor dashboard
 * UI shows: `total` is the whole spend against the plan limit; `auto` is the
 * flat-fee Auto + Composer bucket; `api` is the usage-based-pricing bucket.
 *
 * `billingCycleEndMs` is unix-ms of the reset time. Null if Cursor omits it.
 */
export interface CursorDashboardUsage {
  limitCents: number | null;
  totalSpendCents: number;
  autoPercentUsed: number;
  apiPercentUsed: number;
  totalPercentUsed: number;
  billingCycleEndMs: number | null;
}

/** WorkOS session cookie rejected (3xx redirect to authkit, or 401/403). */
export class CursorDashboardSessionExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CursorDashboardSessionExpiredError';
  }
}

/** Any other non-2xx or transport failure. */
export class CursorDashboardUpstreamError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'CursorDashboardUpstreamError';
    this.status = status;
  }
}

export interface FetchCursorDashboardUsageOptions {
  userId: string;
  accessToken: string;
  fetcher: Fetcher;
}

// Coerce Cursor's mixed number-or-string cents/ms fields into a finite number,
// or fall back if the value is missing/garbage.
const toFiniteNumber = (raw: unknown, fallback: number): number => {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && raw !== '') {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
};

const clampPercent = (raw: unknown): number => {
  const n = toFiniteNumber(raw, 0);
  if (n < 0) return 0;
  if (n > 100) return 100;
  return n;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Fetch current-cycle usage from the Cursor dashboard. Never persists.
 *
 * Session-expired detection: cursor.com redirects to the WorkOS authkit login
 * page when the session cookie is rejected, and `redirect: 'manual'` surfaces
 * that as a 3xx status the caller can distinguish from a genuine upstream 5xx.
 */
export const fetchCursorDashboardUsage = async (
  opts: FetchCursorDashboardUsageOptions,
): Promise<CursorDashboardUsage> => {
  let response: Response;
  try {
    response = await opts.fetcher(CURSOR_DASHBOARD_USAGE_URL, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        Cookie: `WorkosCursorSessionToken=${opts.userId}::${opts.accessToken}`,
        Origin: CURSOR_DASHBOARD_ORIGIN,
        Referer: CURSOR_DASHBOARD_REFERER,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': CURSOR_DASHBOARD_USER_AGENT,
      },
      body: '{}',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CursorDashboardUpstreamError(0, `Cursor dashboard fetch failed: ${message}`);
  }

  if (response.status >= 300 && response.status < 400) {
    throw new CursorDashboardSessionExpiredError(
      'Cursor dashboard redirected to authkit — session cookie rejected. Re-import the credential to recover.',
    );
  }

  if (response.status === 401 || response.status === 403) {
    throw new CursorDashboardSessionExpiredError(
      `Cursor dashboard rejected the session (HTTP ${response.status}). Re-import the credential to recover.`,
    );
  }

  if (!response.ok) {
    const bodyText = (await response.text().catch(() => '')).slice(0, 200);
    throw new CursorDashboardUpstreamError(
      response.status,
      `Cursor dashboard returned HTTP ${response.status}: ${bodyText}`,
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CursorDashboardUpstreamError(response.status, `Cursor dashboard returned non-JSON body: ${message}`);
  }

  if (!isRecord(payload)) {
    throw new CursorDashboardUpstreamError(response.status, 'Cursor dashboard returned non-object body');
  }

  const planUsage = isRecord(payload.planUsage) ? payload.planUsage : {};

  // Cycles with no plan usage have `planUsage: {}` — surface all-zero rather
  // than throw, so the UI can show "no spend this cycle" with reset time.
  const hasPlan = Object.keys(planUsage).length > 0;
  const limitRaw = planUsage.limit;
  const limitCents = hasPlan && (typeof limitRaw === 'number' || typeof limitRaw === 'string')
    ? Math.max(0, toFiniteNumber(limitRaw, 0))
    : null;

  const billingCycleEndRaw = payload.billingCycleEnd;
  const billingCycleEndMs = typeof billingCycleEndRaw === 'number' || typeof billingCycleEndRaw === 'string'
    ? toFiniteNumber(billingCycleEndRaw, 0) || null
    : null;

  return {
    limitCents,
    totalSpendCents: Math.max(0, toFiniteNumber(planUsage.totalSpend, 0)),
    autoPercentUsed: clampPercent(planUsage.autoPercentUsed),
    apiPercentUsed: clampPercent(planUsage.apiPercentUsed),
    totalPercentUsed: clampPercent(planUsage.totalPercentUsed),
    billingCycleEndMs,
  };
};
