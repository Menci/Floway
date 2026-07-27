// Active quota probe against Anthropic's `GET /api/oauth/usage` endpoint.
// Real `@anthropic-ai/claude-code@2.1.181` calls this endpoint directly
// (binary string `fetchUtilization: GET /api/oauth/usage`); mirroring the
// behavior gives operators a clean snapshot of the rate-limit windows
// without burning a model call. The endpoint requires only the OAuth
// bearer plus the same `anthropic-beta: oauth-2025-04-20` header the CLI
// sends on every authenticated request.
//
// Cross-checked third-party gateway:
// https://github.com/Wei-Shaw/sub2api/blob/main/backend/internal/repository/claude_usage_service.go
// hardcodes `defaultClaudeUsageURL = "https://api.anthropic.com/api/oauth/usage"`
// and replays the same headers.
//
// Wire format: per the upstream binary, the response is a JSON document
// shaped roughly as `{five_hour: {utilization, resets_at}, seven_day: {...},
// seven_day_sonnet: {...}, seven_day_opus: {...}}` plus optional overage fields.
// We do not assert the inner shape here — the control plane returns the
// upstream's body verbatim. Anthropic has been adding fields
// (priorIsUsingOverage, hadPriorUtilizationData, ...) without warning;
// a strict parser would reject a perfectly usable new field as malformed.

import { CLAUDE_CODE_OAUTH_USER_AGENT, CLAUDE_CODE_USAGE_PROBE_URL } from './constants.ts';
import type { Fetcher } from '@floway-dev/provider';

export interface ClaudeCodeUsageProbeResult {
  // Stamped by the caller onto its persisted slot so the dashboard can show staleness.
  fetched_at: string;
  // The upstream's body verbatim. We surface as `unknown` because the
  // shape evolves with the CLI version; the dashboard renders by walking
  // the known field names and ignores anything it doesn't understand.
  body: unknown;
}

export const fetchClaudeCodeUsageProbe = async (
  accessToken: string,
  fetcher: Fetcher,
): Promise<ClaudeCodeUsageProbeResult> => {
  const response = await fetcher(CLAUDE_CODE_USAGE_PROBE_URL, {
    method: 'GET',
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: 'application/json',
      'user-agent': CLAUDE_CODE_OAUTH_USER_AGENT,
      // `anthropic-beta` is the only non-trivial header the upstream requires.
      // Without `oauth-2025-04-20` the endpoint returns 401 even with a valid
      // bearer (verified against sub2api's pinned headers).
      'anthropic-beta': 'oauth-2025-04-20',
      'anthropic-version': '2023-06-01',
    },
  });

  const rawText = await response.text();
  if (!response.ok) {
    throw new Error(
      `Claude Code /api/oauth/usage returned ${response.status}: ${rawText.slice(0, 256)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = rawText.length > 0 ? JSON.parse(rawText) : null;
  } catch (cause) {
    throw new Error(
      `Claude Code /api/oauth/usage returned non-JSON body (${response.status})`,
      { cause: cause as Error },
    );
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(
      `Claude Code /api/oauth/usage returned a non-object body (${response.status})`,
    );
  }
  return { fetched_at: new Date().toISOString(), body: parsed };
};
