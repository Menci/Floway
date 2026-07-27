import { CONTEXT_MANAGEMENT_BETA } from './filter-anthropic-beta-header.ts';
import type { MessagesBoundaryCtx } from './types.ts';

/**
 * Copilot's Anthropic-shaped upstream gates the body field `context_management`
 * on the presence of `anthropic-beta: context-management-2025-06-27`. When the
 * body carries the field but the header is missing, both Vertex- and Bedrock-
 * routed deployments reject the request with HTTP 400
 * `context_management: Extra inputs are not permitted` — a deterministic check,
 * not a backend split. Probed against api.enterprise.githubcopilot.com on
 * claude-opus-4.7 / sonnet-4.5 / haiku-4.5: same backend that returns 200 with
 * the header attached returns 400 seconds later when the header is dropped.
 *
 * Claude Code 2.1.x emits the field and the header in lockstep at its single
 * request-builder site, so a desync should not originate from the CLI under
 * normal env. We still see the desync in the wild at low frequency. The exact
 * source remains unconfirmed (a path we missed in the decompile, an env var
 * like CLAUDE_CODE_SIMULATE_PROXY_USAGE, or a wire-level header drop). Rather
 * than chase the upstream cause, repair the symmetry at the boundary: whenever
 * the outgoing payload carries `context_management`, ensure the outgoing
 * `anthropic-beta` carries the matching token. Probes confirm this is safe —
 * Copilot accepts the pair on every model and backend tested.
 *
 * Must run AFTER `withAnthropicBetaHeaderFiltered`, which is the canonical
 * writer of `anthropic-beta` on `ctx.headers`. Reading the post-filter
 * value is the whole point.
 */
export const withContextManagementBetaAligned = async <TResult>(
  ctx: MessagesBoundaryCtx,
  _env: object,
  run: () => Promise<TResult>,
): Promise<TResult> => {
  const payload = ctx.payload as typeof ctx.payload & { context_management?: unknown };
  if (payload.context_management !== undefined) {
    const current = ctx.headers.get('anthropic-beta');
    const tokens = current ? current.split(',').map(value => value.trim()).filter(value => value.length > 0) : [];
    if (!tokens.includes(CONTEXT_MANAGEMENT_BETA)) {
      tokens.push(CONTEXT_MANAGEMENT_BETA);
      ctx.headers.set('anthropic-beta', tokens.join(','));
    }
  }

  return await run();
};
