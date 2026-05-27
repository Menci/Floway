import { parseUserIdMetadata } from './detect-claude-code-metadata.ts';
import { CLAUDE_AGENT_USER_AGENT } from '../../../../../shared/copilot.ts';
import type { MessagesInterceptor } from '../../../../llm/interceptors.ts';

/**
 * When Anthropic Messages traffic comes from the Claude Code SDK proxy, VSCode
 * Copilot Chat re-tags the upstream call with a different intent + user-agent
 * and drops the `copilot-integration-id` it would otherwise pin to
 * `vscode-chat`. We mirror that tagging when both halves of the Claude Code
 * `metadata.user_id` fingerprint are present.
 *
 * Detection requires BOTH safetyIdentifier AND sessionId so we never apply
 * the messages-proxy intent to ordinary chat traffic that happens to share
 * one half of the legacy regex.
 *
 * Sentinel: an empty-string value tells `copilotFetch` to delete the named
 * base header — see the loop comment in shared/copilot.ts. We use it to clear
 * `copilot-integration-id` because VSCode Copilot Chat omits that header on
 * Claude Code SDK proxy traffic.
 *
 * References:
 * - https://github.com/caozhiyuan/copilot-api/blob/main/src/lib/api-config.ts (prepareMessageProxyHeaders)
 */
export const withClaudeAgentHeadersSet: MessagesInterceptor = async (ctx, _request, run) => {
  const { safetyIdentifier, sessionId } = parseUserIdMetadata(ctx.payload.metadata?.user_id);
  if (safetyIdentifier && sessionId) {
    ctx.headers['x-interaction-type'] = 'messages-proxy';
    ctx.headers['openai-intent'] = 'messages-proxy';
    ctx.headers['user-agent'] = CLAUDE_AGENT_USER_AGENT;
    ctx.headers['copilot-integration-id'] = '';
  }
  return await run();
};
