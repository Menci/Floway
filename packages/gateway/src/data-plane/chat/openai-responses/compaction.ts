import { collectOpenAIResponses, openAIResponsesStreamFailure } from './collect.ts';
import { syntheticEventsFromResult } from './items/output.ts';
import { decodeBase64UrlJson, encodeBase64UrlJson } from '../../../shared/base64url-json.ts';
import { isJsonObject } from '../../../shared/json-helpers.ts';
import type { UsageObservation } from '../../pipeline/compute-usage.ts';
import { localResponseHead } from '../../pipeline/encode.ts';
import { defineStage, type GatewayPipelineFacts } from '../../pipeline/facts.ts';
import { MAX_CHAT_COLLECTION_BYTES } from '../shared/collect.ts';
import type { HttpResponseFact } from '@floway-dev/http';
import type { Deferred, ManagedStream, Result } from '@floway-dev/pipeline';
import {
  createRandomOpenAIResponsesItemId,
  isOpenAIResponsesCompactionItem,
  type CanonicalOpenAIResponsesInputItem,
  type CanonicalOpenAIResponsesPayload,
  type OpenAIResponsesOutputItemEx,
  type OpenAIResponsesResultEx,
  type OpenAIResponsesStreamEventEx,
} from '@floway-dev/protocols/openai-responses';
import type { ProtocolError, ProtocolStreamError } from '@floway-dev/provider';

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

// Cache-aligned compactors keep the ordinary system / tools / history prefix
// and append one user instruction that forbids tool use. The tools stay on the
// wire for prefix identity; compaction accepts only assistant text.
// - https://github.com/anomalyco/opencode/blob/a34961825be13a31daa76f33a8b47efcd198cfef/packages/core/src/session/compaction.ts#L272-L309
// - https://github.com/microsoft/vscode-copilot-chat/blob/5863f5a7088958050792b5dccbe8b46c6e13eccc/src/extension/prompts/node/agent/summarizedConversationHistory.tsx#L1086-L1106
const CACHE_SHARING_SUMMARIZATION_PROMPT
  = `${SUMMARIZATION_PROMPT}\n\nDo not call any tools while writing this summary; respond with text only.`;

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

const EXACT_REPEAT_PREFIX = 'Repeat the following text exactly, which may contain a compaction summary, character for character.';
const EXACT_REPEAT_SUFFIX = 'Output only the exact summary text, with no preface, explanation, markdown fence, or changes.';

// ── Inbound expansion ─────────────────────────────────────────────────────────

// Structural validator: a shim payload is an array of input-item objects each
// carrying a `type` field. Strict enough that a foreign opaque blob can't
// accidentally decode + parse + validate.
const isShimCompactionPayload = (value: unknown): value is CanonicalOpenAIResponsesInputItem[] =>
  Array.isArray(value) && value.every(item =>
    isJsonObject(item) && typeof (item as { type?: unknown }).type === 'string');

export const isOpenAIResponsesCompactShimItem = (
  item: { readonly type: string; readonly encrypted_content?: unknown },
): boolean =>
  isOpenAIResponsesCompactionItem(item)
  && typeof item.encrypted_content === 'string'
  && isShimCompactionPayload(decodeBase64UrlJson(item.encrypted_content));

const encodeShimCompactionPayload = (text: string): string =>
  encodeBase64UrlJson([{
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text }],
  } satisfies CanonicalOpenAIResponsesInputItem]);

export const expandShimCompactionItems = <Payload extends { input: CanonicalOpenAIResponsesInputItem[] }>(payload: Payload): Payload => {
  const rewritten: CanonicalOpenAIResponsesInputItem[] = [];
  let changed = false;
  for (const item of payload.input) {
    if (!isOpenAIResponsesCompactionItem(item)) {
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

type ResponseUsage = NonNullable<OpenAIResponsesResultEx['usage']>;

const sumResponseUsage = (left: ResponseUsage | null | undefined, right: ResponseUsage | null | undefined): ResponseUsage | undefined => {
  if (left == null) return right ?? undefined;
  if (right == null) return left;
  return {
    input_tokens: left.input_tokens + right.input_tokens,
    output_tokens: left.output_tokens + right.output_tokens,
    total_tokens: left.total_tokens + right.total_tokens,
    ...(left.input_tokens_details !== undefined || right.input_tokens_details !== undefined
      ? {
          input_tokens_details: {
            cached_tokens: (left.input_tokens_details?.cached_tokens ?? 0) + (right.input_tokens_details?.cached_tokens ?? 0),
            ...(
              left.input_tokens_details?.cache_write_tokens !== undefined
              || right.input_tokens_details?.cache_write_tokens !== undefined
                ? { cache_write_tokens: (left.input_tokens_details?.cache_write_tokens ?? 0) + (right.input_tokens_details?.cache_write_tokens ?? 0) }
                : {}
            ),
          },
        }
      : {}),
    ...(left.output_tokens_details !== undefined || right.output_tokens_details !== undefined
      ? {
          output_tokens_details: {
            reasoning_tokens: (left.output_tokens_details?.reasoning_tokens ?? 0) + (right.output_tokens_details?.reasoning_tokens ?? 0),
          },
        }
      : {}),
  };
};

const summaryTextFrom = (items: readonly OpenAIResponsesOutputItemEx[]): string => {
  const parts: string[] = [];
  for (const item of items) {
    if (item.type !== 'message') continue;
    for (const block of item.content) {
      if (block.type === 'output_text') parts.push(block.text);
    }
  }
  return parts.join('');
};

const summarizationUserMessage = (text: string): CanonicalOpenAIResponsesInputItem => ({
  type: 'message',
  role: 'user',
  content: [{ type: 'input_text', text }],
});

const buildCompactionEnvelope = (cmpId: string, summaryText: string, upstream: OpenAIResponsesResultEx): OpenAIResponsesResultEx => {
  // The prefix lives inside the blob so it round-trips atomically with the
  // summary — a downstream LLM sees `${SUMMARY_PREFIX}\n${summaryText}` in
  // one message and reads it as "another LLM's handoff", not as the human
  // speaking. Encoding the prefix here rather than at expand-time keeps the
  // envelope's semantics complete regardless of who decodes it.
  const encryptedContent = encodeShimCompactionPayload(`${SUMMARY_PREFIX}\n${summaryText}`);

  // `status`, `incomplete_details`, and `error` flow through verbatim from
  // the spread: a summarization turn that hit `max_output_tokens` returns
  // `status: 'incomplete'` with `incomplete_details.reason` set, and an
  // upstream-side failure returns `status: 'failed'` with `error` populated.
  // Synthesizing `status: 'completed'` would have the envelope confidently
  // lie about the underlying turn's outcome.
  return {
    ...upstream,
    id: `resp_compact_shim_${crypto.randomUUID()}`,
    object: 'response.compaction',
    output: [
      {
        type: 'compaction',
        id: cmpId,
        encrypted_content: encryptedContent,
      },
    ] as unknown as OpenAIResponsesResultEx['output'],
  };
};

interface CompactionResponseFacts {
  'response.http': HttpResponseFact | null;
  'response.usage'?: Deferred<UsageObservation>;
  'response.performance'?: GatewayPipelineFacts['response.performance'];
}

type GenerationOutcome =
  | { kind: 'stream'; stream: ManagedStream<OpenAIResponsesStreamEventEx, ProtocolStreamError> }
  | { kind: 'result'; result: OpenAIResponsesResultEx }
  | ProtocolError;

type CompactionResult = { kind: 'result'; result: OpenAIResponsesResultEx } | ProtocolError;

export interface OpenAIResponsesCompactionTurn {
  call: Promise<unknown>;
  response: CompactionResponseFacts;
  outcome: CompactionResult;
}

type CompactionGenerate = (request: CanonicalOpenAIResponsesPayload) => Promise<OpenAIResponsesCompactionTurn>;
type DropCompactionTurn = (turn: OpenAIResponsesCompactionTurn) => void;

interface CompactionReader {
  read(source: ManagedStream<OpenAIResponsesStreamEventEx, ProtocolStreamError>): AsyncIterableIterator<Result<OpenAIResponsesStreamEventEx, ProtocolStreamError>>;
  discard(source: ManagedStream<unknown, unknown>): void;
}

const encoder = new TextEncoder();

export const collectOpenAIResponsesCompactionTurn = async (
  call: Promise<unknown>,
  response: CompactionResponseFacts,
  outcome: GenerationOutcome,
  reader: CompactionReader,
): Promise<OpenAIResponsesCompactionTurn> => {
  if (outcome.kind !== 'stream') return { call, response, outcome };

  const fail = ({ status, ...error }: ReturnType<typeof openAIResponsesStreamFailure>): OpenAIResponsesCompactionTurn => {
    const head = response['response.http'];
    const http = head?.status === status ? head : { ...localResponseHead(status), headers: head?.headers ?? [], body: null };
    return { call, response: { ...response, 'response.http': http }, outcome: error };
  };
  const collector = collectOpenAIResponses();
  let bytes = 0;
  for await (const item of reader.read(outcome.stream)) {
    if (!item.ok) {
      reader.discard(outcome.stream);
      return fail(openAIResponsesStreamFailure(item.error));
    }
    bytes += encoder.encode(JSON.stringify(item.value)).byteLength;
    if (bytes > MAX_CHAT_COLLECTION_BYTES) {
      throw new RangeError(`OpenAI Responses compaction transcript exceeds the ${MAX_CHAT_COLLECTION_BYTES}-byte limit`);
    }
    const error = collector.push(item.value);
    if (error !== undefined) {
      reader.discard(outcome.stream);
      return fail(error);
    }
  }
  const collected = collector.finish();
  return collected.kind === 'error' ? fail(collected) : { call, response, outcome: collected };
};

export const dropOpenAIResponsesCompactionTurn = (
  turn: OpenAIResponsesCompactionTurn,
  scope: {
    abort(call: Promise<unknown>): void;
    discard(handle: Deferred<unknown>): void;
  },
): void => {
  scope.abort(turn.call);
  const usage = turn.response['response.usage'];
  const performance = turn.response['response.performance'];
  if (usage !== undefined) scope.discard(usage);
  if (performance !== undefined) scope.discard(performance);
};

export const simulateOpenAIResponsesCompaction = async (
  payload: CanonicalOpenAIResponsesPayload,
  generate: CompactionGenerate,
  drop: DropCompactionTurn,
  warn: () => void,
): Promise<OpenAIResponsesCompactionTurn> => {
  const history = payload.input.filter(item => item.type !== 'compaction_trigger');
  const first = await generate({ ...payload, store: false, input: [...history, summarizationUserMessage(CACHE_SHARING_SUMMARIZATION_PROMPT)] });
  if (first.outcome.kind === 'error') return first;
  const firstResult = first.outcome.result;
  const firstSummary = summaryTextFrom(firstResult.output);
  if (firstSummary.trim() !== '') {
    return { ...first, outcome: { kind: 'result', result: buildCompactionEnvelope(createRandomOpenAIResponsesItemId('compaction'), firstSummary, firstResult) } };
  }

  drop(first);
  warn();
  const fallback = await generate({
    ...payload,
    store: false,
    input: [
      { type: 'message', role: 'system', content: [{ type: 'input_text', text: SUMMARIZATION_PROMPT }] },
      ...history,
      summarizationUserMessage('<system-reminder>Produce the handoff summary now per the instructions above.</system-reminder>'),
    ],
  });
  if (fallback.outcome.kind === 'error') return fallback;
  const fallbackResult = fallback.outcome.result;
  const summary = summaryTextFrom(fallbackResult.output);
  if (summary.trim() === '') throw new Error('OpenAI Responses compact shim: the summarization turn closed no assistant text to summarize');
  const usage = sumResponseUsage(firstResult.usage, fallbackResult.usage);
  return {
    ...fallback,
    outcome: {
      kind: 'result',
      result: buildCompactionEnvelope(createRandomOpenAIResponsesItemId('compaction'), summary,
        { ...fallbackResult, ...(usage === undefined ? {} : { usage }) }),
    },
  };
};

export const decryptOpenAIResponsesCompaction = async (
  native: OpenAIResponsesCompactionTurn,
  model: string,
  generate: CompactionGenerate,
  drop: DropCompactionTurn,
): Promise<OpenAIResponsesCompactionTurn> => {
  if (native.outcome.kind === 'error') return native;
  const original = native.outcome.result;
  let usage = original.usage;
  let sawCompaction = false;
  const output: OpenAIResponsesOutputItemEx[] = [];

  for (const item of original.output) {
    if (!isOpenAIResponsesCompactionItem(item) || typeof item.encrypted_content !== 'string') {
      output.push(item);
      continue;
    }
    sawCompaction = true;
    const replay = await generate({
      model,
      input: [
        { type: 'message', role: 'system', content: [{ type: 'input_text', text: EXACT_REPEAT_PREFIX }] },
        item,
        { type: 'message', role: 'system', content: [{ type: 'input_text', text: EXACT_REPEAT_SUFFIX }] },
      ],
      store: false,
    });
    if (replay.outcome.kind === 'error') {
      drop(native);
      return replay;
    }
    const replayResult = replay.outcome.result;
    drop(replay);
    const text = summaryTextFrom(replayResult.output);
    if (text.length === 0) throw new Error('OpenAI Responses compact decryption: the replay turn closed no assistant text');
    usage = sumResponseUsage(usage, replayResult.usage);
    output.push({ ...item, encrypted_content: encodeShimCompactionPayload(text) });
  }

  if (!sawCompaction) throw new Error('OpenAI Responses compact decryption: native compaction returned no compaction output item');
  return {
    ...native,
    outcome: { kind: 'result', result: { ...original, output, ...(usage === undefined ? {} : { usage }) } },
  };
};

export const containsCompactionTrigger = (input: readonly CanonicalOpenAIResponsesInputItem[]): boolean =>
  input.some(item => item.type === 'compaction_trigger');

const compactionResponses = ['response.http', 'response.openaiResponses', 'response.usage?', 'response.performance?'] as const;

export const compactOpenAIResponsesHistory = defineStage({
  name: 'openaiResponses.compact-history',
  through: {
    request: { needs: ['request.openaiResponses', 'provider.model'], provides: ['request.openaiResponses'], consumes: [] },
    response: { needs: compactionResponses, provides: ['response.http', 'response.openaiResponses'], consumes: [] },
  },
  async execute(facts, scope) {
    const payload = expandShimCompactionItems(facts['request.openaiResponses']);
    const model = facts['provider.model'];
    const simulate = model.endpoints.openaiResponses === undefined || model.enabledFlags.includes('openai-responses-compact-shim');
    const decrypt = model.enabledFlags.includes('openai-responses-compact-decrypt');
    if (!containsCompactionTrigger(payload.input) || (!simulate && !decrypt)) {
      return await scope.next({ ...facts, 'request.openaiResponses': payload });
    }

    const generate: CompactionGenerate = async request => {
      const call = scope.next({ ...facts, 'request.openaiResponses': request });
      const { 'response.openaiResponses': outcome, ...response } = await call;
      return await collectOpenAIResponsesCompactionTurn(call, response, outcome, scope);
    };
    const drop: DropCompactionTurn = turn => dropOpenAIResponsesCompactionTurn(turn, scope);
    const { response, outcome } = simulate
      ? await simulateOpenAIResponsesCompaction(payload, generate, drop, () =>
          scope.log.warn('Floway: OpenAI Responses compact shim returned no assistant text, retrying with the legacy summarizer'))
      : await decryptOpenAIResponsesCompaction(await generate(payload), payload.model, generate, drop);
    if (outcome.kind === 'error') return { ...response, 'response.openaiResponses': outcome };
    const stream = scope.createStream(async function* (): AsyncGenerator<Result<OpenAIResponsesStreamEventEx, ProtocolStreamError>> {
      for await (const frame of syntheticEventsFromResult(outcome.result)) {
        if (frame.type === 'event') yield { ok: true, value: frame.event };
      }
    });
    return { ...response, 'response.openaiResponses': { kind: 'stream', stream } };
  },
});
