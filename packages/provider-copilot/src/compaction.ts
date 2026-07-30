// Synthesizes the `response.compaction` envelope from Copilot's trigger turn.
// Copilot has no native /responses/compact endpoint and replays the official
// `RemoteCompactionV2` protocol client-side over /responses with stream:false.
// Providers whose upstream exposes native /responses/compact (Azure, Codex,
// custom) call that endpoint directly and bypass this helper entirely.
//
// References:
//   https://github.com/openai/codex/blob/3d805abdf09093bfa806f359a5adc6514766c420/codex-rs/core/src/compact_remote_v2.rs#L439-L501
//   https://github.com/openai/codex/blob/3d805abdf09093bfa806f359a5adc6514766c420/codex-rs/utils/string/src/truncate.rs#L71-L74

import { createRandomResponsesItemId, type ResponsesCompactionResult, type ResponsesCompactionTriggerItem, type ResponsesInputContent, type ResponsesInputItem, type ResponsesInputMessage, type ResponsesOutputItem, type ResponsesResult } from '@floway-dev/protocols/responses';

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
// Retained messages are newly synthesized output items, so their client-visible
// producer IDs are assigned here instead of inherited from input. They are
// resent as full content; the compaction blob carries next-turn state.
export const compactionResponse = (input: ResponsesInputItem[], generated: ResponsesResult): ResponsesCompactionResult => {
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
      id: createRandomResponsesItemId('message'),
      status: item.status ?? 'completed',
      role: item.role,
      content,
      ...(item.phase !== undefined ? { phase: item.phase } : {}),
    });
  }

  // The trigger turn may also emit a stray assistant message, and it may
  // segment its state across several compaction items: `gpt-5-mini-2025-08-07`
  // returns two deterministically, reproduced across six probe variations
  // spanning input size, tool items in the input, streaming, and chained
  // re-feed. The two are independent ciphertexts of 7800 and 8968 bytes, each
  // individually replayable — the first recovers the early turns, the second
  // the full history. Every other Responses model on the same account returns
  // one. `CompactResource` declares `output` as an array with no `minItems`,
  // no `maxItems`, and no prose cardinality rule, and the client contract is to
  // resend the whole array as the next turn's `input`, so a segmented reply is
  // a conformant reply:
  //   https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/public/openapi/openapi.json#L3935-L3953
  //
  // codex hard-fails a compaction count other than one, but that is a
  // consumer-side invariant guarding its own single-blob history model: its
  // client for the native /responses/compact endpoint deserializes `output`
  // whole and returns it with no per-item inspection. We serve the client
  // instead, and keep only the invariant that the turn produced compaction
  // state at all — a model that ignores `compaction_trigger` answers with an
  // ordinary completion carrying no compaction item.
  //   https://github.com/openai/codex/blob/3d805abdf09093bfa806f359a5adc6514766c420/codex-rs/core/src/compact_remote_v2.rs#L380-L428
  //   https://github.com/openai/codex/blob/3d805abdf09093bfa806f359a5adc6514766c420/codex-rs/codex-api/src/endpoint/compact.rs#L39-L88
  const compactionItems = generated.output.filter(it => it.type === 'compaction');
  if (compactionItems.length === 0) {
    throw new Error("Copilot's compaction trigger turn returned no compaction output item");
  }

  return {
    ...generated,
    object: 'response.compaction',
    output: [...kept.reverse(), ...compactionItems] as unknown as ResponsesOutputItem[],
  };
};
