// Compact-shim — simulates a `response.compaction` envelope against upstreams
// that have no native compaction wire.
//
// Engagement is the OR of two conditions:
//   1. The per-upstream `responses-compact-shim` flag is on. This is the
//      operator-controlled opt-in for Responses-target upstreams (codex /
//      copilot / azure / custom) that natively support compaction but where
//      we still want shim-synthesized envelopes.
//   2. The candidate's `targetApi` is not `responses`. When the upstream is
//      Messages or Chat Completions, the translation layer has no concept
//      of a `compaction` output item or a `compaction_trigger` input item.
//      The shim is structurally required regardless of the flag — without
//      it, a `compaction_trigger` item would reach the translator and
//      crash on the unknown variant.
//
// Inner compact-shape detection is also the OR of two conditions:
//   - `invocation.action === 'compact'` (the native `/responses/compact`
//     entry point), or
//   - `invocation.payload.input` contains a `compaction_trigger` item
//     (Codex CLI's RemoteCompactionV2 path: a `generate` call whose input
//     ends in a control item that semantically requests compaction).
//
// Flow when engaged and compact-shaped:
//   1. Inbound: walk `payload.input` for `compaction` items whose
//      `encrypted_content` decodes as our base64url-JSON marker. Each match
//      is replaced inline with the items it originally encoded — so a
//      subsequent turn that echoes back the synthesized compaction sees the
//      summarized history.
//   2. Outbound: pivot the action to 'generate', prepend a role=system
//      message carrying the SUMMARIZATION_PROMPT (vendored from
//      openai/codex), strip any `compaction_trigger` items, append a
//      terminal user message if the history ends on a non-user item
//      (Anthropic Messages rejects assistant prefill), and force
//      `store: false` so the ephemeral summarization turn does not
//      pollute the upstream's conversation history. The caller's
//      `instructions` field flows through untouched — native
//      `/responses/compact` keeps SUMMARIZATION_PROMPT as a system-role
//      prompt AND forwards the caller's instructions as a developer-role
//      message alongside, and we mirror that shape. Call `run()` to
//      drive the chain through the normal generate path; collect the
//      resulting summary text; pack a single user-role message
//      containing the summary into a synthetic `response.compaction`
//      envelope. Mutations of `ctx.payload` / `ctx.action` are one-way
//      per the project's interceptor convention; attempt.invoke does
//      not consume the post-chain `ctx` for its result shape (it keys
//      envelope-drain off the caller's intent action).
//
// Foreign-upstream blobs (opaque strings that fail base64url+JSON decoding
// or fail the array-of-objects-with-string-types schema below) round-trip
// untouched, so the operator can selectively turn the flag off for codex /
// copilot / azure / custom upstreams that natively support compaction.

import type { ResponsesInterceptor, ResponsesInvocation } from './types.ts';
import { decodeBase64UrlJson, encodeBase64UrlJson } from '../../../../shared/base64url-json.ts';
import { isJsonObject } from '../../../../shared/json-helpers.ts';
import type { ChatGatewayCtx } from '../../shared/gateway-ctx.ts';
import { syntheticEventsFromResult } from '../items/output.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import { collectResponsesProtocolEventsToResult, createRandomResponsesItemId, type CanonicalResponsesPayload, type ResponsesInputItem, type ResponsesResult, type ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import { providerModelOf, type ExecuteResult } from '@floway-dev/provider';

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
const isShimCompactionPayload = (value: unknown): value is ResponsesInputItem[] =>
  Array.isArray(value) && value.every(item =>
    isJsonObject(item) && typeof (item as { type?: unknown }).type === 'string');

export const expandShimCompactionItems = (payload: CanonicalResponsesPayload): CanonicalResponsesPayload => {
  const rewritten: ResponsesInputItem[] = [];
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

type ChainRun = () => Promise<ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>>;

// Extracts the summary text from the upstream's response to the
// SUMMARIZATION_PROMPT.
const extractTextFromResult = (result: ResponsesResult): string => {
  const parts: string[] = [];
  for (const item of result.output) {
    if (item.type !== 'message') continue;
    for (const block of item.content) {
      if (block.type === 'output_text') parts.push(block.text);
    }
  }
  return parts.join('');
};

const buildCompactionEnvelope = (cmpId: string, summaryText: string, upstream: ResponsesResult): ResponsesResult => {
  // The prefix lives inside the blob so it round-trips atomically with the
  // summary — a downstream LLM sees `${SUMMARY_PREFIX}\n${summaryText}` in
  // one message and reads it as "another LLM's handoff", not as the human
  // speaking. Encoding the prefix here rather than at expand-time keeps the
  // envelope's semantics complete regardless of who decodes it.
  const summaryItem: ResponsesInputItem = {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: `${SUMMARY_PREFIX}\n${summaryText}` }],
  };
  const encryptedContent = encodeBase64UrlJson([summaryItem]);

  // Drop the SDK-only `output_text` alias that some upstreams emit — its
  // value is the upstream's summary plaintext, which has no place on a
  // synthesized `response.compaction` envelope whose `output` carries only
  // an opaque compaction item. Same destructure precedent at
  // `protocols/responses/from-result.ts:14`.
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
    ] as unknown as ResponsesResult['output'],
  };
};

const simulateCompaction = async (ctx: ResponsesInvocation, gatewayCtx: ChatGatewayCtx, run: ChainRun): Promise<ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>> => {
  const originalPayload = ctx.payload;

  // Strip compaction_trigger so the upstream sees a plain generate turn
  // against SUMMARIZATION_PROMPT.
  const historyItems = originalPayload.input.filter(item => item.type !== 'compaction_trigger');

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
  const terminalUserMessage: ResponsesInputItem = {
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
  // Non-Responses targets (Messages, Chat Completions) don't model a
  // developer role separately from system; the translator downgrades both
  // layers onto a single top-level system slot. That's a strict native
  // capability gap, not a shim regression — nothing this layer can do
  // preserves the split once we cross into a protocol that lacks it.
  const compactorSystemMessage: ResponsesInputItem = {
    type: 'message',
    role: 'system',
    content: [{ type: 'input_text', text: SUMMARIZATION_PROMPT }],
  };
  const inputForSummarization = [compactorSystemMessage, ...historyItems, terminalUserMessage];

  ctx.payload = {
    ...originalPayload,
    input: inputForSummarization,
    // Do not persist the ephemeral summarization turn in the upstream's
    // conversation history.
    store: false,
  };
  // Pivot the action so the inner dispatch routes to the upstream's
  // generate wire instead of its compact wire. The mutation is one-way:
  // the project's interceptor convention is that every `ctx.*` write
  // propagates downstream and is never restored on the way out. Post-chain
  // consumers keep their own captured copies of inputs they care about.
  ctx.action = 'generate';

  const upstreamResult = await run();

  if (upstreamResult.type !== 'events') {
    // api-error / internal-error from the upstream propagate so the client
    // learns the compaction failed rather than receiving a silent empty
    // envelope.
    return upstreamResult;
  }

  const collected = await collectResponsesProtocolEventsToResult(upstreamResult.events);
  const summaryText = extractTextFromResult(collected);
  const cmpId = createRandomResponsesItemId('compaction');
  const synthesized = buildCompactionEnvelope(cmpId, summaryText, collected);

  return {
    ...upstreamResult,
    events: syntheticEventsFromResult(synthesized),
  };
};

export const containsCompactionTrigger = (input: readonly ResponsesInputItem[]): boolean =>
  input.some(item => item.type === 'compaction_trigger');

export const withResponsesCompactShim: ResponsesInterceptor = async (ctx, gatewayCtx, run) => {
  // The shim is engaged when the operator turned it on for this upstream,
  // OR when the upstream's targetApi is not Responses (Messages /
  // Chat Completions have no compaction wire and would crash on the
  // unknown `compaction_trigger` input variant).
  const flagOn = providerModelOf(ctx.candidate).enabledFlags.has('responses-compact-shim');
  const structurallyRequired = ctx.targetApi !== 'responses';
  if (!flagOn && !structurallyRequired) return await run();

  // Inbound: expand any prior shim-encoded compactions back into their
  // original items so the upstream sees the summarized history.
  ctx.payload = expandShimCompactionItems(ctx.payload);

  // Compact-shaped requests are either the native `/responses/compact`
  // action or a `generate` call whose input ends in a `compaction_trigger`.
  const isCompactShaped = ctx.action === 'compact' || containsCompactionTrigger(ctx.payload.input);
  if (!isCompactShaped) return await run();

  return await simulateCompaction(ctx, gatewayCtx, run);
};
