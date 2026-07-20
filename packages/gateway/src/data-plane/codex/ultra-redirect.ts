import type { CanonicalResponsesPayload, ResponsesInputItem } from '@floway-dev/protocols/responses';

const MULTI_AGENT_MODE_OPEN_TAG = '<multi_agent_mode>';
const MULTI_AGENT_MODE_CLOSE_TAG = '</multi_agent_mode>';

// Codex selects Proactive mode from the client-side Ultra value, injects this
// developer block, then maps the request's wire effort to `max`. The Responses
// body and client metadata carry no separate original-effort field, so the
// latest mode block is the only source-protocol signal that distinguishes
// Ultra from an explicit Max selection.
// https://github.com/openai/codex/blob/2deed3fb9c00c74dac3d177ea700d6fb7a94539d/codex-rs/core/src/session/multi_agents.rs#L39-L67
// https://github.com/openai/codex/blob/2deed3fb9c00c74dac3d177ea700d6fb7a94539d/codex-rs/core/src/context/multi_agent_mode_instructions.rs#L6-L47
// https://github.com/openai/codex/blob/2deed3fb9c00c74dac3d177ea700d6fb7a94539d/codex-rs/core/src/client.rs#L175-L180
const PROACTIVE_MODE_PREFIX = 'Proactive multi-agent delegation is active.';
const EXPLICIT_MODE_PREFIX = 'Do not spawn sub-agents unless the user or applicable AGENTS.md/skill instructions explicitly ask';

export type CodexMultiAgentMode = 'proactive' | 'explicit-request-only' | 'unknown';

const messageText = (item: ResponsesInputItem): string | null => {
  if (item.type !== 'message' || item.role !== 'developer') return null;
  if (typeof item.content === 'string') return item.content;
  return item.content
    .filter(block => block.type === 'input_text' || block.type === 'output_text')
    .map(block => block.text)
    .join('\n');
};

const lastModeBody = (text: string): string | null => {
  let searchFrom = text.length;
  while (searchFrom > 0) {
    const open = text.lastIndexOf(MULTI_AGENT_MODE_OPEN_TAG, searchFrom);
    if (open < 0) return null;
    const bodyStart = open + MULTI_AGENT_MODE_OPEN_TAG.length;
    const close = text.indexOf(MULTI_AGENT_MODE_CLOSE_TAG, bodyStart);
    if (close >= 0) return text.slice(bodyStart, close).trim();
    searchFrom = open - 1;
  }
  return null;
};

export const activeCodexMultiAgentMode = (input: readonly ResponsesInputItem[]): CodexMultiAgentMode => {
  for (let index = input.length - 1; index >= 0; index--) {
    const text = messageText(input[index]!);
    if (text === null) continue;
    const body = lastModeBody(text);
    if (body === null) continue;
    if (body.startsWith(PROACTIVE_MODE_PREFIX)) return 'proactive';
    if (body.startsWith(EXPLICIT_MODE_PREFIX)) return 'explicit-request-only';
    // A later custom or future mode block supersedes older history. Fail open
    // instead of treating a stale Proactive block as the active selection.
    return 'unknown';
  }
  return 'unknown';
};

export const redirectCodexUltraEffort = (
  payload: CanonicalResponsesPayload,
  redirectEffort: string,
): CanonicalResponsesPayload => {
  const effort = payload.reasoning?.effort;
  if (effort !== 'max' && effort !== 'ultra') return payload;
  if (activeCodexMultiAgentMode(payload.input) !== 'proactive') return payload;
  return {
    ...payload,
    reasoning: { ...payload.reasoning, effort: redirectEffort },
  };
};
