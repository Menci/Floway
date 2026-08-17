// What a simulated compaction is made of. The rules that use these run as stages and are
// tested where they run — `responses-pipeline_test.ts` for the generate chain and
// `responses-compact_test.ts` for the compaction chain; what is written down here is the
// substance those stages send and pack.

import { test } from 'vitest';

import {
  buildCompactionEnvelope,
  expandShimCompactionItems,
  summarizationTurnFor,
  summaryTextFrom,
  SUMMARY_PREFIX,
} from '../../../../src/data-plane/chat/responses/compact-shim.ts';
import { decodeBase64UrlJson, encodeBase64UrlJson } from '../../../../src/shared/base64url-json.ts';
import type { CanonicalResponsesPayload, ResponsesInputItem, ResponsesOutputItem, ResponsesResult } from '@floway-dev/protocols/responses';
import { assertEquals } from '@floway-dev/test-utils';

const turnFor = (payload: Partial<CanonicalResponsesPayload> = {}): CanonicalResponsesPayload =>
  summarizationTurnFor({ model: 'test-model', input: [], ...payload } as CanonicalResponsesPayload);

/** The items a turn was rewritten into, as the assertions below read them. */
const itemsOf = (payload: CanonicalResponsesPayload): { type: string; role?: string; content?: { type: string; text: string }[] }[] =>
  payload.input as { type: string; role?: string; content?: { type: string; text: string }[] }[];

/** What the summarization turn produced, as an upstream states it. */
const summarized = (text: string, overrides: Partial<ResponsesResult> = {}): ResponsesResult => ({
  id: 'resp_fake_upstream',
  object: 'response',
  model: 'test-upstream-model',
  status: 'completed',
  output: [{
    type: 'message',
    id: 'msg_1',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }],
  }],
  error: null,
  incomplete_details: null,
  usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
  ...overrides,
});

/** The items a compaction blob stands for. The blob is this gateway's own base64url-JSON
 *  marker, so what a test reads back is what a later turn's expansion would. */
const decodeBlob = (encryptedContent: string): { type: string; role: string; content: { type: string; text: string }[] }[] => {
  const decoded = decodeBase64UrlJson(encryptedContent);
  if (decoded === null) throw new Error('expected a shim-encoded compaction blob');
  return decoded as { type: string; role: string; content: { type: string; text: string }[] }[];
};

// ── Inbound expansion (expandShimCompactionItems) ────────────────────────────

test('inbound: compaction item with a shim-encoded payload expands inline', () => {
  const userItem = { type: 'message' as const, role: 'user' as const, content: 'history one' };
  const encoded = encodeBase64UrlJson([userItem]);

  const expanded = expandShimCompactionItems({
    model: 'm',
    input: [
      { type: 'compaction', id: 'cmp_1', encrypted_content: encoded } as unknown as never,
      { type: 'message', role: 'user', content: 'new turn' },
    ],
  });

  assertEquals(expanded.input.length, 2);
  assertEquals(expanded.input[0], userItem);
  assertEquals(expanded.input[1], { type: 'message', role: 'user', content: 'new turn' });
});

test('inbound: foreign compaction blob (non-base64url-JSON) round-trips untouched', () => {
  const original = {
    model: 'm',
    input: [
      { type: 'compaction', id: 'cmp_native', encrypted_content: 'OPAQUE_NATIVE_BLOB' } as unknown as never,
    ],
  };
  const expanded = expandShimCompactionItems(original);
  // No items expanded — the foreign blob fails decode and the item passes
  // through as-is.
  assertEquals(expanded, original);
});

test('inbound: foreign compaction blob (valid base64url but wrong shape) round-trips untouched', () => {
  // base64url-encoded JSON of an object (not an array) — decode succeeds,
  // but the schema check rejects it.
  const wrongShape = encodeBase64UrlJson({ not: 'an array' });
  const original = {
    model: 'm',
    input: [
      { type: 'compaction', id: 'cmp_foreign', encrypted_content: wrongShape } as unknown as never,
    ],
  };
  const expanded = expandShimCompactionItems(original);
  assertEquals(expanded, original);
});

// ── The summarization turn (summarizationTurnFor) ────────────────────────────

test('the turn carries SUMMARIZATION_PROMPT as a role=system item at the head of the history, and persists nothing', () => {
  const turn = turnFor({ input: [{ type: 'message', role: 'user', content: 'long conversation history' }] });

  const compactorSystem = itemsOf(turn)[0]!;
  assertEquals(compactorSystem.type, 'message');
  assertEquals(compactorSystem.role, 'system');
  assertEquals(compactorSystem.content![0]!.text.includes('CONTEXT CHECKPOINT COMPACTION'), true);
  // The ephemeral summarization turn does not pollute the upstream's own conversation
  // history.
  assertEquals(turn.store, false);
});

test("the caller's `instructions` field flows through untouched (bug-for-bug parity with native compact)", () => {
  // Native `/responses/compact` puts SUMMARIZATION_PROMPT into the compactor
  // context as a role=system message AND forwards the caller's `instructions`
  // as a developer-role message alongside; both are in scope. Prompt-
  // injection extraction against the live Copilot upstream confirmed a
  // caller-supplied `instructions="always mention 'quokka'"` reaches the
  // compactor as a developer message and shows up inside the produced
  // summary. The shim must reproduce that shape — do NOT overwrite the
  // caller's instructions with SUMMARIZATION_PROMPT (it now lives as a
  // separate role=system input item).
  const turn = turnFor({
    input: [{ type: 'message', role: 'user', content: 'history' }],
    instructions: 'You are a helpful assistant. Always mention the word quokka.',
  });

  assertEquals(turn.instructions, 'You are a helpful assistant. Always mention the word quokka.');
  const compactorSystem = itemsOf(turn)[0]!;
  assertEquals(compactorSystem.role, 'system');
  assertEquals(compactorSystem.content![0]!.text.includes('CONTEXT CHECKPOINT COMPACTION'), true);
});

test('a caller with no `instructions` still gets the compactor prompt, and the slot stays absent', () => {
  // Baseline: when the caller sends no `instructions` field, the shim still
  // injects SUMMARIZATION_PROMPT via the role=system input item — matching
  // native compact, which always has its system-role compactor prompt in
  // scope regardless of whether the caller supplies a developer message.
  // The `instructions` slot stays unset so a downstream translator does not
  // synthesize a phantom developer message from thin air.
  const turn = turnFor({ input: [{ type: 'message', role: 'user', content: 'history' }] });

  assertEquals(turn.instructions, undefined);
  const compactorSystem = itemsOf(turn)[0]!;
  assertEquals(compactorSystem.type, 'message');
  assertEquals(compactorSystem.role, 'system');
  assertEquals(compactorSystem.content![0]!.text.includes('CONTEXT CHECKPOINT COMPACTION'), true);
});

test('compaction_trigger items are stripped from the history the compactor is sent', () => {
  const turn = turnFor({
    input: [
      { type: 'message', role: 'user', content: 'real history' },
      { type: 'compaction_trigger' } as unknown as never,
    ],
  });

  assertEquals(itemsOf(turn).every(item => item.type !== 'compaction_trigger'), true);
});

test('a history ending on an assistant message gets a synthetic terminal user prompt appended', () => {
  // Anthropic Messages rejects assistant prefill: a conversation that
  // ends on an assistant turn returns 400 `This model does not support
  // assistant message prefill`. The shim normalizes by appending a
  // synthetic user-role nudge so the summarization call always ends on
  // a user message — harmless on OpenAI-style upstreams and load-bearing
  // for translated Anthropic ones.
  const turn = turnFor({
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello back', annotations: [] }] } as unknown as never,
    ],
  });

  // [SUMMARIZATION_PROMPT system, user 'hi', assistant 'hello back', synthetic user nudge]
  const items = itemsOf(turn);
  assertEquals(items.length, 4);
  assertEquals(items[0]!.role, 'system');
  const tail = items[items.length - 1]!;
  assertEquals(tail.type, 'message');
  assertEquals(tail.role, 'user');
  assertEquals(tail.content![0]!.type, 'input_text');
});

// ── The summary, and the envelope it is packed into ──────────────────────────

test('the summary is the item the turn closed, not the output its terminal stated', () => {
  const message: ResponsesOutputItem = {
    type: 'message',
    id: 'msg_1',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text: 'CONDENSED SUMMARY', annotations: [] }],
  };

  assertEquals(summaryTextFrom(new Map([[0, message]]), []), 'CONDENSED SUMMARY');
  // A turn that closed nothing falls back to the terminal, as the client-facing egress does.
  assertEquals(summaryTextFrom(new Map(), [message]), 'CONDENSED SUMMARY');
});

test('the synthesized encrypted_content decodes to a user message carrying the summary behind the handoff prefix', () => {
  const envelope = buildCompactionEnvelope('cmp_1', 'THE SUMMARY', summarized('THE SUMMARY'));

  assertEquals(envelope.object, 'response.compaction');
  const item = envelope.output[0] as unknown as { type: string; id: string; encrypted_content: string };
  assertEquals(item.type, 'compaction');
  assertEquals(item.id, 'cmp_1');
  // The prefix rides inside the blob so a downstream LLM that echoes the compaction back
  // reads the message as "another LLM's handoff summary", not as raw user speech.
  const decoded = decodeBlob(item.encrypted_content);
  assertEquals(decoded.length, 1);
  assertEquals(decoded[0]!.type, 'message');
  assertEquals(decoded[0]!.role, 'user');
  assertEquals(decoded[0]!.content[0]!.type, 'input_text');
  assertEquals(decoded[0]!.content[0]!.text, `${SUMMARY_PREFIX}\nTHE SUMMARY`);
  // The envelope is answered under an id of this gateway's own rather than the summarization
  // turn's.
  assertEquals(envelope.id === 'resp_fake_upstream', false);
});

test("the upstream's `output_text` SDK alias is dropped from the synthesized envelope", () => {
  // Some upstreams (and some OpenAPI implementations) emit the convenience
  // `output_text` alias alongside `output`. The synthesized
  // `response.compaction` envelope must not forward it — its value is the
  // upstream's summary plaintext, which a downstream SDK reading
  // `output_text` on a compaction envelope would surface in place of the
  // opaque-blob contract `encrypted_content` is supposed to carry.
  const envelope = buildCompactionEnvelope(
    'cmp_1',
    'THE SUMMARY',
    summarized('THE SUMMARY', { output_text: 'THE SUMMARY' } as Partial<ResponsesResult>),
  );

  assertEquals(envelope.output_text, undefined);
});

test('an incomplete summarization turn says so on the envelope it backs', () => {
  // A summarization that hit `max_output_tokens` mid-stream comes back with
  // `status: 'incomplete'` and `incomplete_details` populated. The synthesized
  // envelope must surface that — not pretend the turn ran to completion.
  const envelope = buildCompactionEnvelope('cmp_1', 'partial summary', summarized('partial summary', {
    status: 'incomplete',
    incomplete_details: { reason: 'max_output_tokens' },
  }));

  assertEquals(envelope.status, 'incomplete');
  assertEquals(envelope.incomplete_details, { reason: 'max_output_tokens' });
});

// ── Round-trip ────────────────────────────────────────────────────────────────

test('round-trip: what one turn packed is what the next turn is sent', () => {
  const envelope = buildCompactionEnvelope('cmp_rt', 'SUMMARY TEXT', summarized('SUMMARY TEXT'));
  const item = envelope.output[0] as unknown as { id: string; encrypted_content: string };

  // The next turn echoes the compaction item back as an input item; expansion replaces it
  // with the summary message, carrying the handoff prefix baked in at encode time.
  const expanded = expandShimCompactionItems({
    model: 'test-model',
    input: [{ type: 'compaction', id: item.id, encrypted_content: item.encrypted_content } as unknown as ResponsesInputItem],
  });

  const items = expanded.input as { type: string; role: string; content: { type: string; text: string }[] }[];
  assertEquals(items.length, 1);
  assertEquals(items[0]!.type, 'message');
  assertEquals(items[0]!.role, 'user');
  assertEquals(items[0]!.content[0]!.text, `${SUMMARY_PREFIX}\nSUMMARY TEXT`);
});
