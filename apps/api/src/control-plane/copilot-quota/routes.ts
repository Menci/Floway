// GET /api/upstreams/:id/copilot/quota — fetch Copilot usage/quota info for one upstream.

import type { Context } from 'hono';

import { getRepo } from '../../repo/index.ts';
import { githubHeaders } from '../../shared/copilot.ts';

interface QuotaDetail {
  entitlement: number;
  overage_count: number;
  overage_permitted: boolean;
  percent_remaining: number;
  quota_id: string;
  quota_remaining: number;
  remaining: number;
  unlimited: boolean;
}

interface CopilotUsageResponse {
  access_type_sku: string;
  analytics_tracking_id: string;
  assigned_date: string;
  can_signup_for_limited: boolean;
  chat_enabled: boolean;
  copilot_plan: string;
  organization_login_list: unknown[];
  organization_list: unknown[];
  quota_reset_date: string;
  quota_snapshots: {
    chat: QuotaDetail;
    completions: QuotaDetail;
    premium_interactions: QuotaDetail;
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const githubTokenFromConfig = (config: unknown): string | null => {
  if (!isRecord(config) || typeof config.githubToken !== 'string' || config.githubToken.length === 0) return null;
  return config.githubToken;
};

export const copilotQuota = async (c: Context) => {
  try {
    const id = c.req.param('id') ?? '';
    const upstream = await getRepo().upstreams.getById(id);
    if (!upstream) return c.json({ error: 'Upstream not found' }, 404);
    if (upstream.provider !== 'copilot') return c.json({ error: 'Upstream is not a Copilot upstream' }, 400);

    const githubToken = githubTokenFromConfig(upstream.config);
    if (!githubToken) return c.json({ error: 'Copilot upstream is missing githubToken' }, 400);

    const resp = await fetch('https://api.github.com/copilot_internal/user', { headers: githubHeaders(githubToken) });

    if (!resp.ok) {
      const text = await resp.text();
      // Map upstream 401/403 to 502 so the dashboard client doesn't confuse
      // "GitHub credential issue" with "your dashboard auth is invalid" and logout.
      const status = resp.status === 401 || resp.status === 403 ? 502 : resp.status;
      return c.json(
        { error: `GitHub API error: ${resp.status} ${text}` },
        status as 400 | 404 | 500 | 502,
      );
    }

    const data = (await resp.json()) as CopilotUsageResponse;
    return c.json(data);
  } catch (e: unknown) {
    console.error('Failed to fetch Copilot quota:', e);
    return c.json({ error: 'Failed to fetch Copilot quota from GitHub' }, 502);
  }
};
