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
//   2. Outbound: pivot the action to 'generate', swap in the
//      SUMMARIZATION_PROMPT (vendored from openai/codex), strip any
//      `compaction_trigger` items, append a terminal user message if the
//      history ends on a non-user item (Anthropic Messages rejects
//      assistant prefill), and force `store: false` so the ephemeral
//      summarization turn does not pollute the upstream's conversation
//      history. Call `run()` to drive the chain through the normal generate
//      path; collect the resulting summary text; pack a single user-role
//      message containing the summary into a synthetic
//      `response.compaction` envelope. Mutations of `ctx.payload` /
//      `ctx.action` are one-way per the project's interceptor convention;
//      attempt.invoke does not consume the post-chain `ctx` for its result
//      shape (it keys envelope-drain off the caller's intent action).
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
import { collectResponsesProtocolEventsToResult, type ResponsesInputItem, type ResponsesResult, type ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import { providerModelOf, type ExecuteResult } from '@floway-dev/provider';
import type { CanonicalResponsesPayload } from '@floway-dev/translate/via-responses/responses-items';

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
  const summaryItem: ResponsesInputItem = {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: summaryText }],
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
  const inputForSummarization = [...historyItems, terminalUserMessage];

  ctx.payload = {
    ...originalPayload,
    input: inputForSummarization,
    instructions: SUMMARIZATION_PROMPT,
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
  // The minted compaction id is gateway-internal — the upstream never issued
  // it. Register it as synthetic so `wrapResponsesOutputForStorage` stores
  // the row with `upstreamId: null`, which keeps `classifyStoredResponsesAffinity`
  // from treating a future echo of this compaction as a forcing reference that
  // pins routing to whichever upstream happened to run the summarization turn.
  // (For non-responses targets the targetApi check already suppresses
  // ownership; this also covers the responses-target + flag-on engagement.)
  const cmpId = `cmp_${crypto.randomUUID()}`;
  gatewayCtx.store.addSyntheticItem(cmpId);
  const synthesized = buildCompactionEnvelope(cmpId, summaryText, collected);

  return {
    ...upstreamResult,
    events: syntheticEventsFromResult(synthesized),
  };
};

// True when the payload carries a `compaction_trigger` input item — Codex
// CLI's RemoteCompactionV2 path that semantically requests compaction
// through `action: 'generate'`. Exported so callers outside the shim
// (attempt.ts's snapshot-mode derivation) can ask the same question.
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
