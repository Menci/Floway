import type { MessagesInterceptor } from '../../../../llm/interceptors.ts';
import type { MessagesMessage, MessagesTextBlock } from '@floway-dev/protocols/messages';

/**
 * Claude Code (and OpenCode) periodically asks the model to summarize the
 * conversation so the next turn can run against a compacted transcript. VSCode
 * Copilot Chat tags those calls with a different intent + interaction-type so
 * Copilot's accounting and abuse controls treat the call as a compaction step
 * instead of a user-facing turn. Separately, both agents also resume from a
 * fresh out-of-context cut by sending an "auto-continue" prompt; VSCode marks
 * those as agent-initiated (without the compaction interaction-type) so they
 * still bill as continuation rather than a brand-new user turn. We mirror both
 * tagging shapes when we detect them, so Copilot-side billing attribution
 * stays consistent with what real VSCode users produce.
 *
 * Detection is purely structural — we never read auth or per-tenant metadata.
 *
 * References:
 * - https://github.com/caozhiyuan/copilot-api/blob/main/src/lib/compact.ts
 * - https://github.com/caozhiyuan/copilot-api/blob/main/src/routes/messages/preprocess.ts (getCompactType)
 * - https://github.com/caozhiyuan/copilot-api/blob/main/src/lib/api-config.ts (prepareForCompact)
 */

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
const lastMessageText = (message: MessagesMessage): string => {
  if (message.role !== 'user') return '';
  if (typeof message.content === 'string') return message.content;
  return message.content
    .filter((block): block is MessagesTextBlock => block.type === 'text')
    .map(block => (block.text.startsWith('<system-reminder>') ? '' : block.text))
    .filter(text => text.length > 0)
    .join('\n\n');
};

const isCompactLastMessage = (message: MessagesMessage | undefined): boolean => {
  if (!message) return false;
  const text = lastMessageText(message);
  if (!text) return false;
  // All three markers must be present together; the text-only guard alone
  // appears in unrelated Claude Code prompts and would over-match.
  return text.includes(COMPACT_TEXT_ONLY_GUARD) && text.includes(COMPACT_SUMMARY_PROMPT_START) && COMPACT_MESSAGE_SECTIONS.some(section => text.includes(section));
};

const isAutoContinueLastMessage = (message: MessagesMessage | undefined): boolean => {
  if (!message) return false;
  const text = lastMessageText(message);
  if (!text) return false;
  return COMPACT_AUTO_CONTINUE_PROMPT_STARTS.some(prefix => text.startsWith(prefix));
};

const startsWithCompactSystemPrompt = (text: string): boolean => COMPACT_SYSTEM_PROMPT_STARTS.some(prefix => text.startsWith(prefix));

const isCompactSystemPrompt = (system: string | MessagesTextBlock[] | undefined): boolean => {
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
const classifyCompact = (payload: { messages: MessagesMessage[]; system?: string | MessagesTextBlock[] }): CompactClass => {
  const last = payload.messages.at(-1);
  if (isCompactLastMessage(last)) return 'compact-request';
  if (isAutoContinueLastMessage(last)) return 'auto-continue';
  if (isCompactSystemPrompt(payload.system)) return 'compact-request';
  return null;
};

export const withCompactHeadersSet: MessagesInterceptor = async (ctx, _request, run) => {
  const kind = classifyCompact(ctx.payload);
  if (kind === 'compact-request') {
    ctx.headers['x-initiator'] = 'agent';
    ctx.headers['x-interaction-type'] = 'conversation-compaction';
    // openai-intent stays at copilotFetch's `conversation-agent` default — that
    // is the same value caozhiyuan/copilot-api re-pins inside prepareForCompact,
    // so explicitly setting it here would be a no-op.
  } else if (kind === 'auto-continue') {
    // Auto-continue gets only the agent-initiator tag; interaction-type stays
    // at copilotFetch's `conversation-agent` default. This mirrors
    // prepareForCompact's behavior when compactType === COMPACT_AUTO_CONTINUE:
    // it sets x-initiator: agent and leaves x-interaction-type untouched.
    ctx.headers['x-initiator'] = 'agent';
  }
  return await run();
};
