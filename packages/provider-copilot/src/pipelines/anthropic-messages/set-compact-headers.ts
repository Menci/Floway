import { defineCopilotStage } from '../facts.ts';
import { setHeader } from '@floway-dev/http';
import { move, transform } from '@floway-dev/pipeline';
import type { AnthropicMessagesMessage, AnthropicMessagesTextBlockParam } from '@floway-dev/protocols/anthropic-messages';
// Constants ported verbatim from caozhiyuan/copilot-api so detection drift
// stays observable when their values move.
const COMPACT_TEXT_ONLY_GUARD = 'CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.';
const COMPACT_SUMMARY_PROMPT_START = 'Your task is to create a detailed summary of the conversation so far';
const COMPACT_MESSAGE_SECTIONS = ['Pending Tasks:', 'Current Work:'] as const;
const COMPACT_SYSTEM_PROMPT_STARTS = [
  'You are a helpful AI assistant tasked with summarizing conversations',
  'You are an anchored context summarization assistant for coding sessions.',
] as const;

// Auto-continue prompts: the first user turn after Claude Code / OpenCode
// resume from an out-of-context cut. The text comes from the agent harness,
// not the human, so VSCode-shaped accounting treats it as agent-initiated.
// See caozhiyuan's `compactAutoContinuePromptStarts` for the source list.
const COMPACT_AUTO_CONTINUE_PROMPT_STARTS = [
  // Claude Code resume prompt.
  'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.',
  // OpenCode primary continuation prompt.
  'Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.',
  // OpenCode media-eviction continuation prompt.
  "The previous request exceeded the provider's size limit due to large media attachments. The conversation was compacted and media files were removed from context.",
] as const;

// Compact-summary and auto-continue prompts are always authored as a fresh
// user turn — the agent harness injects them on the human's behalf. An
// assistant history item whose text happens to start with one of those
// markers (e.g. a client that round-trips the previous request's user turn
// back as assistant history) must not trip compact tagging, so the extractor
// returns empty text for any non-user role. This mirrors caozhiyuan's
// `getCompactCandidateText`:
// https://github.com/caozhiyuan/copilot-api/blob/main/src/routes/messages/preprocess.ts#L94
//
// `<system-reminder>` blocks are Claude Code's own injected reminders that
// the agent never authored; they should never count as compact-summary
// evidence either.
const lastMessageText = (message: AnthropicMessagesMessage): string => {
  if (message.role !== 'user') return '';
  if (typeof message.content === 'string') return message.content;
  return message.content
    .filter((block): block is AnthropicMessagesTextBlockParam => block.type === 'text')
    .map(block => (block.text.startsWith('<system-reminder>') ? '' : block.text))
    .filter(text => text.length > 0)
    .join('\n\n');
};

const isCompactLastMessage = (message: AnthropicMessagesMessage | undefined): boolean => {
  if (!message) return false;
  const text = lastMessageText(message);
  if (!text) return false;
  // All three markers must be present together; the text-only guard alone
  // appears in unrelated Claude Code prompts and would over-match.
  return text.includes(COMPACT_TEXT_ONLY_GUARD) && text.includes(COMPACT_SUMMARY_PROMPT_START) && COMPACT_MESSAGE_SECTIONS.some(section => text.includes(section));
};

const isAutoContinueLastMessage = (message: AnthropicMessagesMessage | undefined): boolean => {
  if (!message) return false;
  const text = lastMessageText(message);
  if (!text) return false;
  return COMPACT_AUTO_CONTINUE_PROMPT_STARTS.some(prefix => text.startsWith(prefix));
};

const startsWithCompactSystemPrompt = (text: string): boolean => COMPACT_SYSTEM_PROMPT_STARTS.some(prefix => text.startsWith(prefix));

const isCompactSystemPrompt = (system: string | AnthropicMessagesTextBlockParam[] | undefined): boolean => {
  if (typeof system === 'string') return startsWithCompactSystemPrompt(system);
  if (Array.isArray(system)) return system.some(block => startsWithCompactSystemPrompt(block.text));
  return false;
};

type CompactClass = 'compact-request' | 'auto-continue' | null;

// Match caozhiyuan's `getCompactType` priority exactly: last-message
// compact-summary wins, then last-message auto-continue, then system-prompt
// compact-summary. This ordering matters because a single payload could in
// principle match more than one shape, and the COMPACT_REQUEST tagging is
// strictly stronger than the auto-continue tagging.
const classifyCompact = (payload: { messages: AnthropicMessagesMessage[]; system?: string | AnthropicMessagesTextBlockParam[] }): CompactClass => {
  const last = payload.messages.at(-1);
  if (isCompactLastMessage(last)) return 'compact-request';
  if (isAutoContinueLastMessage(last)) return 'auto-continue';
  if (isCompactSystemPrompt(payload.system)) return 'compact-request';
  return null;
};
// https://github.com/caozhiyuan/copilot-api/blob/88840ed80000635902b90a35989b1e795d289fdf/src/routes/messages/preprocess.ts
// https://github.com/caozhiyuan/copilot-api/blob/88840ed80000635902b90a35989b1e795d289fdf/src/lib/api-config.ts
export const setCompactHeaders = defineCopilotStage({
  name: 'copilot.anthropicMessages.setCompactHeaders',
  through: {
    request: { needs: ['request.anthropicMessages', 'request.http'], provides: ['request.http'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  execute: transform(() => ({
    request(facts) {
      const payload = facts['request.anthropicMessages'];
      const request = facts['request.http'];
      const kind = classifyCompact(payload);
      if (kind === null) return facts;
      let headers = setHeader(request.headers, 'x-initiator', 'agent');
      if (kind === 'compact-request') headers = setHeader(headers, 'x-interaction-type', 'conversation-compaction');
      return { ...facts, 'request.http': move({ ...request, headers }) };
    },
  })),
});
