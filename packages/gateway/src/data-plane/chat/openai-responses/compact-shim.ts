// Compact-shim — what a `response.compaction` envelope is made of, where no upstream wire
// makes one.
//
// The rules that use these are stages: `simulatesCompaction` says which candidates'
// compactions are the shim's to make, `expandShimCompactions` puts a blob of ours back into
// the items it stood for, and `summarizeForCompaction` sends the turn built here and packs
// what comes back (`responses/pipeline.ts`). Both of this protocol's chains compose them,
// because a compaction the shim wrote is issued through one entry — `/v1/responses/compact`,
// or a generate turn whose input ends in a `compaction_trigger` — and echoed back into the
// other by the client that received it.
//
// What is here is the shim's own substance:
//
//   - `expandShimCompactionItems`: walk `payload.input` for `compaction` items whose
//     `encrypted_content` decodes as our base64url-JSON marker, and replace each inline with
//     the items it originally encoded — so a turn that echoes back a synthesized compaction
//     is sent the summarized history rather than a blob.
//   - `summarizationTurnFor`: the turn a compaction is simulated with. A role=system message
//     carrying the SUMMARIZATION_PROMPT (vendored from openai/codex) at the head of the
//     history, any `compaction_trigger` items stripped, a terminal user message appended
//     where the history ends on a non-user item (Anthropic Messages rejects assistant
//     prefill), and `store: false` so the ephemeral summarization turn does not pollute the
//     upstream's conversation history. The caller's `instructions` field flows through
//     untouched — native `/responses/compact` keeps SUMMARIZATION_PROMPT as a system-role
//     prompt AND forwards the caller's instructions as a developer-role message alongside,
//     and we mirror that shape.
//   - `summaryTextFrom` and `buildCompactionEnvelope`: the summary the turn produced, and the
//     synthetic `response.compaction` envelope carrying it as a blob only this gateway reads.
//
// Foreign-upstream blobs (opaque strings that fail base64url+JSON decoding or fail the
// array-of-objects-with-string-types schema below) round-trip untouched, so the operator can
// selectively turn the flag off for the codex / copilot / azure / custom upstreams that
// answer compact themselves.

import { decodeBase64UrlJson, encodeBase64UrlJson } from '../../../shared/base64url-json.ts';
import { isJsonObject } from '../../../shared/json-helpers.ts';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesInputItem, OpenAIResponsesOutputItem, OpenAIResponsesResult } from '@floway-dev/protocols/openai-responses';

// The two vendored constants below (SUMMARIZATION_PROMPT and SUMMARY_PREFIX)
// are the compactor system prompt and the handoff prefix openai/codex ships
// for local remote-v2 compaction. Both are also the exact strings Copilot's
// server-side compactor uses today — Copilot's `/responses` endpoint hosts
// the same compaction infrastructure as openai/codex, verbatim.
//
// The equivalence was confirmed by prompt-injection extraction against the
// live Copilot upstream, following the methodology at
// https://yuanchang.org/en/posts/investigating-codex-context-compaction/:
//   1. Call `/responses` with `{input: [{role: user, content: INJECTION}, {type: 'compaction_trigger'}], stream: false}`.
//      Copilot returns a `type: 'compaction'` output item whose
//      `encrypted_content` is a Fernet-encrypted blob containing the
//      compactor's plaintext summary.
//   2. Call `/responses` again with `{input: [<same user injection>, <compaction item from step 1>, {role: user, content: PROBE}]}`.
//      The server decrypts the blob, prepends SUMMARY_PREFIX, hands it to
//      the target model, which sees the injection payload smuggled inside
//      the summary and — if it complies with the probe — echoes the
//      compactor's system prompt (SUMMARIZATION_PROMPT) and the handoff
//      prefix (SUMMARY_PREFIX) back verbatim.
// INJECTION is a fake "project notes" user message carrying a bracketed
// pseudo-system directive that asks the compactor to quote any received
// message mentioning "CONTEXT CHECKPOINT" / "handoff summary" / "concise"
// / "seamlessly" between INSTRUCTION_START/END markers before writing its
// normal summary. PROBE then asks the target model to output the full
// text of any context message containing those markers or key phrases
// (INSTRUCTION_START, "Another language model", "ChatGPT",
// "CONTEXT CHECKPOINT"). See the article for the exact payloads.
//
// Coverage: all five gpt-5* models an enterprise Copilot account can reach
// (gpt-5-mini, gpt-5.3-codex, gpt-5.4-mini, gpt-5.4, gpt-5.5), 3+ runs
// each. `gpt-5-mini` leaked SUMMARIZATION_PROMPT and SUMMARY_PREFIX
// character-identical to the vendored openai/codex strings on 3/3 runs;
// `gpt-5.4` and `gpt-5.5` refused every probe (stronger alignment);
// `gpt-5.3-codex` leaked its base identity but withheld the compactor
// prompt. The confirming `gpt-5-mini` leaks make it strictly unlikely
// the model invented these strings from scratch — the byte-level match
// against a specific-length prompt with a specific bullet ordering is
// far outside the space of plausible hallucinations. Bumps to
// openai/codex's `compact/prompt.md` or `compact/summary_prefix.md` are
// therefore also the signal to bump these constants.

// Vendored from openai/codex (Apache-2.0):
// https://github.com/openai/codex/blob/ba2b67f9cda954bcdda43c2a65ac58e807b996bd/codex-rs/prompts/templates/compact/prompt.md
const SUMMARIZATION_PROMPT
  = 'You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.\n\n'
  + 'Include:\n'
  + '- Current progress and key decisions made\n'
  + '- Important context, constraints, or user preferences\n'
  + '- What remains to be done (clear next steps)\n'
  + '- Any critical data, examples, or references needed to continue\n\n'
  + 'Be concise, structured, and focused on helping the next LLM seamlessly continue the work.';

// Trivial short histories tend to yield noticeably longer summaries from
// the shim than from native compact (the shim runs SUMMARIZATION_PROMPT
// through a normal `/responses` generate call, and the model dutifully
// fills every Include bullet; native's compactor short-circuits on
// trivial inputs). On realistic long histories the gap closes. Not a
// correctness bug — downstream turns behave the same either way — so we
// accept the drift rather than cap output and risk truncating summaries
// that long tasks legitimately need.

// Vendored from openai/codex (Apache-2.0):
// https://github.com/openai/codex/blob/ba2b67f9cda954bcdda43c2a65ac58e807b996bd/codex-rs/prompts/templates/compact/summary_prefix.md
//
// Prepended to the summary text before the summary is packed into the
// synthesized compaction envelope. Without this prefix, the next turn's
// downstream LLM sees a raw user-role message whose contents are a
// prose summary and misreads it as something the human said. The prefix
// makes the message's provenance explicit — "another LLM produced this
// summary, use it to continue the task" — matching what the native
// server-side compact endpoint prepends to the decrypted blob.
//
// The concatenation is `${SUMMARY_PREFIX}\n${summaryText}` — a single
// newline separator, mirroring codex-rs/core/src/compact.rs:271
// (`format!("{SUMMARY_PREFIX}\n{summary_suffix}")`):
// https://github.com/openai/codex/blob/ba2b67f9cda954bcdda43c2a65ac58e807b996bd/codex-rs/core/src/compact.rs#L271
const SUMMARY_PREFIX
  = 'Another language model started to solve this problem and produced a summary of its thinking process.'
  + ' You also have access to the state of the tools that were used by that language model. Use this to'
  + ' build on the work that has already been done and avoid duplicating work. Here is the summary produced'
  + ' by the other language model, use the information in this summary to assist with your own analysis:';

export { SUMMARY_PREFIX };

// ── Inbound expansion ─────────────────────────────────────────────────────────

// Structural validator: a shim payload is an array of input-item objects each
// carrying a `type` field. Strict enough that a foreign opaque blob can't
// accidentally decode + parse + validate.
const isShimCompactionPayload = (value: unknown): value is OpenAIResponsesInputItem[] =>
  Array.isArray(value) && value.every(item =>
    isJsonObject(item) && typeof (item as { type?: unknown }).type === 'string');

export const expandShimCompactionItems = (payload: CanonicalOpenAIResponsesPayload): CanonicalOpenAIResponsesPayload => {
  const rewritten: OpenAIResponsesInputItem[] = [];
  let changed = false;
  for (const item of payload.input) {
    if (item.type !== 'compaction') {
      rewritten.push(item);
      continue;
    }
    const encryptedContent = (item as { encrypted_content?: unknown }).encrypted_content;
    if (typeof encryptedContent !== 'string') {
      rewritten.push(item);
      continue;
    }
    const decoded = decodeBase64UrlJson(encryptedContent);
    if (!isShimCompactionPayload(decoded)) {
      // Foreign blob — leave untouched so a native-compaction upstream still
      // sees its own encrypted_content verbatim.
      rewritten.push(item);
      continue;
    }
    rewritten.push(...decoded);
    changed = true;
  }
  return changed ? { ...payload, input: rewritten } : payload;
};

// ── Outbound summarization ────────────────────────────────────────────────────

// The spec makes the item lifecycle the authority and requires nothing of the
// terminal's `output`; a Codex upstream states an `output` that omits the
// assistant message it just closed. A turn that closed nothing falls back to
// the terminal, as the client-facing egress does.
// https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/src/specifications/2026-04-24.mdx#L237
export const summaryTextFrom = (closed: Map<number, OpenAIResponsesOutputItem>, stated: readonly OpenAIResponsesOutputItem[]): string => {
  const items = closed.size === 0
    ? stated
    : [...closed].sort(([left], [right]) => left - right).map(([, item]) => item);
  const parts: string[] = [];
  for (const item of items) {
    if (item.type !== 'message') continue;
    for (const block of item.content) {
      if (block.type === 'output_text') parts.push(block.text);
    }
  }
  return parts.join('');
};

export const buildCompactionEnvelope = (cmpId: string, summaryText: string, upstream: OpenAIResponsesResult): OpenAIResponsesResult => {
  // The prefix lives inside the blob so it round-trips atomically with the
  // summary — a downstream LLM sees `${SUMMARY_PREFIX}\n${summaryText}` in
  // one message and reads it as "another LLM's handoff", not as the human
  // speaking. Encoding the prefix here rather than at expand-time keeps the
  // envelope's semantics complete regardless of who decodes it.
  const summaryItem: OpenAIResponsesInputItem = {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: `${SUMMARY_PREFIX}\n${summaryText}` }],
  };
  const encryptedContent = encodeBase64UrlJson([summaryItem]);

  // Drop the SDK-only `output_text` alias that some upstreams emit — its
  // value is the upstream's summary plaintext, which has no place on a
  // synthesized `response.compaction` envelope whose `output` carries only
  // an opaque compaction item. Same destructure precedent at
  // `protocols/openai-responses/from-result.ts:14`.
  const { output_text: _droppedOutputText, ...upstreamBase } = upstream;

  // `status`, `incomplete_details`, and `error` flow through verbatim from
  // the spread: a summarization turn that hit `max_output_tokens` returns
  // `status: 'incomplete'` with `incomplete_details.reason` set, and an
  // upstream-side failure returns `status: 'failed'` with `error` populated.
  // Synthesizing `status: 'completed'` would have the envelope confidently
  // lie about the underlying turn's outcome.
  return {
    ...upstreamBase,
    id: `resp_compact_shim_${crypto.randomUUID()}`,
    object: 'response.compaction',
    output: [
      {
        type: 'compaction',
        id: cmpId,
        encrypted_content: encryptedContent,
      },
    ] as unknown as OpenAIResponsesResult['output'],
  };
};

// The turn a compaction is simulated with: the compactor's own prompt, the
// history that is being compacted, and a nudge to produce the summary now.
// Exported because the pipeline's compaction chain sends the same turn — one
// definition is what keeps the simulated compaction identical whichever entry
// asked for it.
export const summarizationTurnFor = (payload: CanonicalOpenAIResponsesPayload): CanonicalOpenAIResponsesPayload => {
  // Strip compaction_trigger so the upstream sees a plain generate turn
  // against SUMMARIZATION_PROMPT.
  const historyItems = payload.input.filter(item => item.type !== 'compaction_trigger');

  // Anthropic Messages rejects assistant prefill — when the translated
  // conversation ends on an assistant message, the upstream returns 400
  // `This model does not support assistant message prefill. The conversation
  // must end with a user message.`. The history we hand to the
  // summarization turn ends on whatever the last real turn produced
  // (frequently assistant after a normal user→assistant round-trip), so
  // append a synthetic terminal user message that nudges the model into
  // producing the summary. Harmless on OpenAI-style upstreams, which accept
  // assistant-terminal conversations but happily honor a final user prompt.
  //
  // Wrap the nudge in `<system-reminder>…</system-reminder>` — Claude Code's
  // documented convention for injecting synthetic system-level context into
  // a `user`-role message without it reading as a literal user instruction.
  // Claude models are trained to recognize the marker as an out-of-band
  // reminder; on non-Claude upstreams the wrapper is a benign opaque tag
  // they ignore. See https://github.com/anthropics/claude-code/issues/52018
  // (the report on system-reminder semantics) for the convention's reach.
  const terminalUserMessage: OpenAIResponsesInputItem = {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: '<system-reminder>Produce the handoff summary now per the instructions above.</system-reminder>' }],
  };

  // Native `/responses/compact` puts SUMMARIZATION_PROMPT into the compactor
  // context as a role=system message and forwards the caller's `instructions`
  // as a role=developer message alongside it — both are in scope
  // simultaneously. Confirmed by prompt-injection extraction against the
  // live Copilot upstream: a caller who sets `instructions="always mention
  // quokka"` leaks a summary whose reasoning trace names it as "the
  // developer message", and a caller who sets an adversarial
  // `instructions="PIRATE SUMMARY: yarr!"` can outright hijack the
  // compactor's output shape — proof that SUMMARIZATION_PROMPT stays in
  // scope but the caller's instructions can override it under standard
  // system-vs-developer role weighting.
  //
  // Bug-for-bug parity means the shim must reproduce that shape:
  //   - SUMMARIZATION_PROMPT rides as a role=system input item at the head
  //     of the history — always injected, never overridable.
  //   - The caller's original `instructions` flows through unchanged, so
  //     the same benign/adversarial semantics carry over. Any hijack blast
  //     radius stays confined to the caller's own subsequent blob (that
  //     caller only pollutes their own next-turn summary), matching native.
  //
  // Non-OpenAI-Responses targets (Anthropic Messages, OpenAI Chat Completions) don't model a
  // developer role separately from system; the translator downgrades both
  // layers onto a single top-level system slot. That's a strict native
  // capability gap, not a shim regression — nothing this layer can do
  // preserves the split once we cross into a protocol that lacks it.
  const compactorSystemMessage: OpenAIResponsesInputItem = {
    type: 'message',
    role: 'system',
    content: [{ type: 'input_text', text: SUMMARIZATION_PROMPT }],
  };
  return {
    ...payload,
    input: [compactorSystemMessage, ...historyItems, terminalUserMessage],
    // Do not persist the ephemeral summarization turn in the upstream's
    // conversation history.
    store: false,
  };
};

// A summarization that closed no assistant text produced no summary, and a
// compaction blob is the whole of what the next turn inherits — so an empty one
// silently discards the conversation.
export const EMPTY_SUMMARY_MESSAGE = 'Responses compact shim: the summarization turn closed no assistant text to summarize';

export const containsCompactionTrigger = (input: readonly OpenAIResponsesInputItem[]): boolean =>
  input.some(item => item.type === 'compaction_trigger');
