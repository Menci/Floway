import { CLAUDE_AGENT_USER_AGENT } from '../../auth.ts';
import { defineCopilotStage } from '../facts.ts';
import { parseUserIdMetadata } from './detect-claude-code-metadata.ts';
import { deleteHeader, setHeader } from '@floway-dev/http';
import { move, transform } from '@floway-dev/pipeline';
// Copilot rejects the SDK proxy identity on this model while accepting the VS Code identity.
// https://github.com/microsoft/vscode-copilot-chat/blob/5863f5a7088958050792b5dccbe8b46c6e13eccc/src/extension/chatSessions/claude/node/claudeLanguageModelServer.ts#L479-L516
const UPSTREAM_REJECTS_CLAUDE_AGENT_IDENTITY = new Set(['claude-opus-4-8']);
// Both halves of the Claude Code SDK proxy fingerprint must be present.
// https://github.com/caozhiyuan/copilot-api/blob/88840ed80000635902b90a35989b1e795d289fdf/src/services/copilot/create-messages.ts#L110-L116
export const setClaudeAgentHeaders = defineCopilotStage({
  name: 'copilot.anthropicMessages.setClaudeAgentHeaders',
  through: {
    request: { needs: ['request.anthropicMessages', 'request.http', 'provider.model'], provides: ['request.http'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  execute: transform(() => ({
    request(facts) {
      const payload = facts['request.anthropicMessages'];
      const request = facts['request.http'];
      if (UPSTREAM_REJECTS_CLAUDE_AGENT_IDENTITY.has(facts['provider.model'].id)) return facts;
      const { safetyIdentifier, sessionId } = parseUserIdMetadata('metadata' in payload ? payload.metadata?.user_id ?? undefined : undefined);
      if (!safetyIdentifier || !sessionId) return facts;
      let headers = setHeader(request.headers, 'x-interaction-type', 'messages-proxy');
      headers = setHeader(headers, 'openai-intent', 'messages-proxy');
      headers = setHeader(headers, 'user-agent', CLAUDE_AGENT_USER_AGENT);
      headers = deleteHeader(headers, 'copilot-integration-id');
      return { ...facts, 'request.http': move({ ...request, headers }) };
    },
  })),
});
