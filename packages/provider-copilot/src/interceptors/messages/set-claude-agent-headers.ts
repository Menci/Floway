import { parseUserIdMetadata } from './detect-claude-code-metadata.ts';
import type { CopilotMessagesBoundaryInterceptor } from './types.ts';
import { CLAUDE_AGENT_USER_AGENT } from '../../auth.ts';

/**
 * When Anthropic Messages traffic comes from the Claude Code SDK proxy, VSCode
 * Copilot Chat re-tags the native Messages upstream call with a different
 * intent + user-agent and drops the `copilot-integration-id` it would otherwise
 * pin to `vscode-chat`. We mirror that tagging only when the planner selected
 * a native Messages target and both halves of the Claude Code
 * `metadata.user_id` fingerprint are present.
 *
 * Detection requires BOTH safetyIdentifier AND sessionId so we never apply
 * the messages-proxy intent to ordinary chat traffic that happens to share
 * one half of the legacy regex.
 *
 * Sentinel: an empty-string value tells `copilotAuthedFetch` in
 * `packages/provider-copilot/src/auth.ts` to delete the named base header. We
 * use it to clear `copilot-integration-id` because VSCode Copilot Chat omits
 * that header on Claude Code SDK proxy traffic.
 *
 * Do not put this identity on translated Chat Completions / Responses targets.
 * The real VS Code path forces a Messages API request, and caozhiyuan's gateway
 * applies the same helper only in its `/v1/messages` Copilot caller. Copilot's
 * Chat endpoint treats the full messages-proxy + Claude Code UA + no-integration
 * shape as `integrator: claude-code`, which can hide non-Claude Chat models.
 *
 * `claude-opus-4-8` is currently excluded: that model's upstream WAF returns
 * a generic 403 ("Access to this endpoint is forbidden") whenever a request
 * carries the Claude-Code-style user-agent without a `copilot-integration-id`
 * header. The same header set is accepted on `claude-opus-4-7`, so the gate
 * is a model-id rollout gap on Copilot's side, not a policy choice on ours.
 * Skipping the rewrite for 4-8 keeps the default Copilot identity (vscode-chat
 * integration id + GitHubCopilotChat UA + conversation-agent intent) in
 * place; that path is 200. TODO: remove this skip once Copilot's upstream
 * accepts the Claude-Code identity on 4-8. Probed 2026-05-29.
 *
 * References:
 * - https://github.com/microsoft/vscode-copilot-chat/blob/5863f5a7088958050792b5dccbe8b46c6e13eccc/src/extension/chatSessions/claude/node/claudeLanguageModelServer.ts#L479-L516
 * - https://github.com/caozhiyuan/copilot-api/blob/88840ed80000635902b90a35989b1e795d289fdf/src/services/copilot/create-messages.ts#L110-L116
 * - https://github.com/caozhiyuan/copilot-api/blob/88840ed80000635902b90a35989b1e795d289fdf/src/services/copilot/create-chat-completions.ts#L45-L61
 */
const UPSTREAM_REJECTS_CLAUDE_AGENT_IDENTITY = new Set(['claude-opus-4-8']);

export const withClaudeAgentHeadersSet: CopilotMessagesBoundaryInterceptor = async (ctx, _env, run) => {
  if (UPSTREAM_REJECTS_CLAUDE_AGENT_IDENTITY.has(ctx.payload.model)) {
    return await run();
  }

  const { safetyIdentifier, sessionId } = parseUserIdMetadata(ctx.payload.metadata?.user_id);
  if (safetyIdentifier && sessionId) {
    ctx.headers.set('x-interaction-type', 'messages-proxy');
    ctx.headers.set('openai-intent', 'messages-proxy');
    ctx.headers.set('user-agent', CLAUDE_AGENT_USER_AGENT);
    ctx.headers.set('copilot-integration-id', '');
  }
  return await run();
};
