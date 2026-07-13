// Shared helper for synthesizing the `response.compaction` envelope from a
// trigger turn that returns one `compaction` output item. Used by Copilot,
// which has no native /responses/compact endpoint and replays the official
// `RemoteCompactionV2` protocol client-side over /responses with stream:false.
// Providers whose upstream exposes native /responses/compact (Azure, Codex,
// custom) call that endpoint directly and bypass this helper entirely.
//
// References (codex @ ebb79803697acee75baf24073ef49af87ad7e483):
//   codex-rs/core/src/compact_remote_v2.rs#L409-L457
//   codex-rs/utils/string/src/truncate.rs#L71-L74

import type { ResponsesCompactionTriggerItem, ResponsesInputContent, ResponsesInputItem, ResponsesInputMessage, ResponsesOutputItem, ResponsesResult } from '@floway-dev/protocols/responses';

export const COMPACTION_TRIGGER: ResponsesCompactionTriggerItem = { type: 'compaction_trigger' };

// Native compact retains `user` + `assistant` + `developer` + `system` —
// confirmed empirically against an OpenAI long fixture (287 user + 286
// assistant messages co-retained). Only tool/function items are absorbed by
// the encrypted blob. codex's `is_retained_for_remote_compaction_v2` drops
// assistant; production captures show the server keeps it.
const RETAINED_ROLES = new Set(['user', 'assistant', 'developer', 'system']);

// codex's retained-message budget (its comment notes it mirrors the server-side
// `/responses/compact` default) and its token heuristic `ceil(utf8_bytes / 4)`,
// with non-text content costing nothing.
const RETAINED_BUDGET_TOKENS = 64_000;
const APPROX_BYTES_PER_TOKEN = 4;
const encoder = new TextEncoder();

// Native compact echoes every text part — including assistant `output_text` —
// as `input_text` so the client can resend `output` verbatim as next-turn
// `input`. Normalize unconditionally; non-text content passes through and costs
// 0 tokens against the retained budget.
const normalizeContent = (content: ResponsesInputMessage['content']): ResponsesInputContent[] => {
  if (typeof content === 'string') return [{ type: 'input_text', text: content }];
  return content.map(part => (part.type === 'output_text' ? { ...part, type: 'input_text' } : part));
};

const isRetainedMessage = (item: ResponsesInputItem): item is ResponsesInputMessage =>
  item.type === 'message' && RETAINED_ROLES.has(item.role);

// The retained items are input-shaped messages with canonical input content,
// which is what `/responses/compact` echoes so the client can resend `output`
// as the next turn's `input`. `ResponsesOutputItem` does not model user/system
// roles, so the final cast records that the compaction envelope's `output` is
// deliberately input-shaped.
//
// A retained message with no id gets a synthetic one (so the store can mint a
// stored id and persist it). Retained messages persist as upstream-owned with
// an id the upstream never issued (giving them `portable` affinity); the
// compaction blob carries the real `forcing` affinity. Benign: retained
// messages are resent as full content rather than `item_reference`s, so the
// synthetic id is never replayed to the upstream.
export const compactionResponse = (input: ResponsesInputItem[], generated: ResponsesResult): ResponsesResult => {
  const kept: ResponsesInputMessage[] = [];
  let used = 0;
  for (let i = input.length - 1; i >= 0; i -= 1) {
    const item = input[i];
    if (!isRetainedMessage(item)) continue;

    const content = normalizeContent(item.content);
    const tokens = content.reduce((sum, part) =>
      part.type === 'input_text'
        ? sum + Math.ceil(encoder.encode(part.text).length / APPROX_BYTES_PER_TOKEN)
        : sum, 0);
    used += Math.max(tokens, 1);
    if (used > RETAINED_BUDGET_TOKENS && kept.length > 0) break;

    kept.push({
      type: 'message',
      id: item.id ?? `msg_${crypto.randomUUID().replace(/-/g, '')}`,
      status: item.status ?? 'completed',
      role: item.role,
      content,
      ...(item.phase !== undefined ? { phase: item.phase } : {}),
    });
  }

  // The trigger turn may also emit a stray assistant message; codex ignores
  // everything but the lone compaction item and errors if it is not exactly one.
  const compactionItems = generated.output.filter(it => it.type === 'compaction');
  if (compactionItems.length !== 1) {
    throw new Error(`Expected exactly one compaction output item, got ${compactionItems.length}`);
  }

  return {
    ...generated,
    object: 'response.compaction',
    output: [...kept.reverse(), compactionItems[0]] as unknown as ResponsesOutputItem[],
  };
};
