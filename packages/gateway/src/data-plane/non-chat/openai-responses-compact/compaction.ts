import { decodeBase64UrlJson, encodeBase64UrlJson } from '../../../shared/base64url-json.ts';
import { collectChatStream, MAX_CHAT_COLLECTION_BYTES, type ChatCollectionError } from '../../chat/pipeline/collect.ts';
import { openAIResponsesFailureEvents, openAIResponsesStreamErrorPayload } from '../../chat/pipeline/stream-error.ts';
import type { UsageObservation } from '../../pipeline/compute-usage.ts';
import type { GatewayDump } from '../../pipeline/services.ts';
import type { HttpResponseFact } from '@floway-dev/http';
import type { Deferred, Facts, ManagedStream, Result } from '@floway-dev/pipeline';
import { isJsonObject } from '@floway-dev/protocols/common';
import {
  createRandomOpenAIResponsesItemId,
  isOpenAIResponsesCompactionItem,
  OPENAI_RESPONSES_MISSING_TERMINAL_MESSAGE,
  type CanonicalOpenAIResponsesInputItem,
  type CanonicalOpenAIResponsesPayload,
  type OpenAIResponsesCompactionResultEx,
  type OpenAIResponsesResultEx,
  type OpenAIResponsesStoredItem,
  type OpenAIResponsesStreamEventEx,
} from '@floway-dev/protocols/openai-responses';
import { internalDebugErrorFields, toInternalDebugError, type ProtocolStreamError, type UpstreamOutcome } from '@floway-dev/upstream';

// https://github.com/openai/codex/blob/ba2b67f9cda954bcdda43c2a65ac58e807b996bd/codex-rs/prompts/templates/compact/prompt.md
const SUMMARIZATION_PROMPT
  = 'You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.\n\n'
  + 'Include:\n'
  + '- Current progress and key decisions made\n'
  + '- Important context, constraints, or user preferences\n'
  + '- What remains to be done (clear next steps)\n'
  + '- Any critical data, examples, or references needed to continue\n\n'
  + 'Be concise, structured, and focused on helping the next LLM seamlessly continue the work.';

// Keep the input prefix intact so the summarization call can reuse its cache.
// https://github.com/anomalyco/opencode/blob/a34961825be13a31daa76f33a8b47efcd198cfef/packages/core/src/session/compaction.ts#L272-L309
const CACHE_SHARING_SUMMARIZATION_PROMPT
  = `${SUMMARIZATION_PROMPT}\n\nDo not call any tools while writing this summary; respond with text only.`;

// https://github.com/openai/codex/blob/ba2b67f9cda954bcdda43c2a65ac58e807b996bd/codex-rs/prompts/templates/compact/summary_prefix.md
export const SUMMARY_PREFIX
  = 'Another language model started to solve this problem and produced a summary of its thinking process.'
  + ' You also have access to the state of the tools that were used by that language model. Use this to'
  + ' build on the work that has already been done and avoid duplicating work. Here is the summary produced'
  + ' by the other language model, use the information in this summary to assist with your own analysis:';

const EXACT_REPEAT_PREFIX = 'Repeat the following text exactly, which may contain a compaction summary, character for character.';
const EXACT_REPEAT_SUFFIX = 'Output only the exact summary text, with no preface, explanation, markdown fence, or changes.';

const isShimCompactionPayload = (value: unknown): value is CanonicalOpenAIResponsesInputItem[] =>
  Array.isArray(value) && value.every(item => isJsonObject(item) && typeof item.type === 'string');

export const isOpenAIResponsesCompactShimItem = (item: { readonly type: string; readonly encrypted_content?: unknown }): boolean =>
  isOpenAIResponsesCompactionItem(item)
  && typeof item.encrypted_content === 'string'
  && isShimCompactionPayload(decodeBase64UrlJson(item.encrypted_content));

const userMessage = (text: string): CanonicalOpenAIResponsesInputItem => ({
  type: 'message', role: 'user', content: [{ type: 'input_text', text }],
});

const encodeShimCompactionPayload = (text: string): string => encodeBase64UrlJson([userMessage(text)]);

const encodeBoundedSummary = (text: string): string => {
  const content = encodeShimCompactionPayload(text);
  if (content.length > MAX_CHAT_COLLECTION_BYTES) {
    throw new RangeError(`OpenAI Responses compaction summary exceeds the ${MAX_CHAT_COLLECTION_BYTES}-byte limit`);
  }
  return content;
};

export const expandShimCompactionItems = <Payload extends { input: CanonicalOpenAIResponsesInputItem[] }>(payload: Payload): Payload => {
  let changed = false;
  const input = payload.input.flatMap(item => {
    if (!isOpenAIResponsesCompactionItem(item) || typeof item.encrypted_content !== 'string') return [item];
    const decoded = decodeBase64UrlJson(item.encrypted_content);
    if (!isShimCompactionPayload(decoded)) return [item];
    changed = true;
    return decoded;
  });
  return changed ? { ...payload, input } : payload;
};

export const containsCompactionTrigger = (input: readonly CanonicalOpenAIResponsesInputItem[]): boolean =>
  input.some(item => item.type === 'compaction_trigger');

type Usage = OpenAIResponsesCompactionResultEx['usage'];

const sumResponseUsage = (left: Usage, right: Usage): Usage => {
  if (left == null) return right ?? undefined;
  if (right == null) return left;
  const oldInput = left.input_tokens_details;
  const newInput = right.input_tokens_details;
  const oldOutput = left.output_tokens_details;
  const newOutput = right.output_tokens_details;
  const oldWrite = oldInput?.cache_write_tokens;
  const newWrite = newInput?.cache_write_tokens;
  return {
    input_tokens: left.input_tokens + right.input_tokens,
    output_tokens: left.output_tokens + right.output_tokens,
    total_tokens: left.total_tokens + right.total_tokens,
    ...(oldInput !== undefined || newInput !== undefined ? {
      input_tokens_details: {
        cached_tokens: (oldInput?.cached_tokens ?? 0) + (newInput?.cached_tokens ?? 0),
        ...(oldWrite !== undefined || newWrite !== undefined ? { cache_write_tokens: (oldWrite ?? 0) + (newWrite ?? 0) } : {}),
      },
    } : {}),
    ...(oldOutput !== undefined || newOutput !== undefined ? {
      output_tokens_details: { reasoning_tokens: (oldOutput?.reasoning_tokens ?? 0) + (newOutput?.reasoning_tokens ?? 0) },
    } : {}),
  };
};

const summaryTextFrom = (items: readonly OpenAIResponsesStoredItem[]): string => {
  const parts: string[] = [];
  for (const item of items) {
    if (item.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const block of item.content) {
      if (block.type === 'output_text') parts.push(block.text);
    }
  }
  return parts.join('');
};

const buildCompactionEnvelope = (summary: string, upstream: OpenAIResponsesCompactionResultEx): OpenAIResponsesCompactionResultEx => ({
  ...upstream,
  id: `resp_compact_shim_${crypto.randomUUID()}`,
  object: 'response.compaction',
  output: [{
    type: 'compaction',
    id: createRandomOpenAIResponsesItemId('compaction'),
    encrypted_content: encodeBoundedSummary(`${SUMMARY_PREFIX}\n${summary}`),
  }],
});

type CompactionResponseFacts = {
  http: HttpResponseFact | null;
  usage?: Deferred<UsageObservation>;
  usageModelKey?: string;
};

type GenerationOutcome = UpstreamOutcome<'openaiResponses'> | { kind: 'result'; result: OpenAIResponsesResultEx };

export interface OpenAIResponsesCompactionTurn {
  call: Promise<unknown>;
  answer: Facts;
  response: CompactionResponseFacts;
  outcome: UpstreamOutcome<'openaiResponsesCompact'>;
}

type CompactionGenerate = (request: CanonicalOpenAIResponsesPayload) => Promise<OpenAIResponsesCompactionTurn>;
type DropCompactionTurn = (turn: OpenAIResponsesCompactionTurn) => void;

type Source = ManagedStream<OpenAIResponsesStreamEventEx, ProtocolStreamError>;

interface CompactionReader {
  read(source: Source): AsyncIterableIterator<Result<OpenAIResponsesStreamEventEx, ProtocolStreamError>>;
  discard(source: Source): void;
  readonly services: { readonly dump: GatewayDump | null };
}

// https://github.com/openai/openai-node/blob/b579bcb3e586d22269ffe6fe504653a0e05acbe8/src/core/error.ts#L60-L94
const errorHttpStatus = new Map([
  ['invalid_request_error', 400],
  ['invalid_prompt', 400],
  ['authentication_error', 401],
  ['invalid_api_key', 401],
  ['permission_error', 403],
  ['not_found_error', 404],
  ['conflict_error', 409],
  ['unprocessable_entity_error', 422],
  ['rate_limit_error', 429],
  ['rate_limit_exceeded', 429],
  ['insufficient_quota', 429],
  ['server_error', 500],
  ['internal_error', 500],
]);

const compactionStreamFailure = (failure: ProtocolStreamError): ChatCollectionError => {
  const { notification, failed } = openAIResponsesFailureEvents(failure);
  if (notification !== undefined) {
    const body = openAIResponsesStreamErrorPayload(notification);
    const details = isJsonObject(body.provider_specific_fields) ? body.provider_specific_fields : undefined;
    const status = [body.code, body.type, details?.code, details?.type]
      .flatMap(value => typeof value === 'string' ? errorHttpStatus.get(value) ?? [] : [])[0] ?? 502;
    const { sequence_number: _sequenceNumber, ...error } = notification;
    return { status, outcome: { kind: 'error', source: 'upstream', error } };
  }
  if (failed !== undefined) {
    return { status: 502, outcome: { kind: 'error', source: 'upstream', error: { error: failed.response.error } } };
  }
  const error = toInternalDebugError(failure.cause);
  const source = failure.kind === 'abort' ? 'local' : 'upstream';
  return {
    status: source === 'local' ? 499 : 502,
    outcome: { kind: 'error', source, error: { error: { type: error.type, message: error.message, provider_specific_fields: internalDebugErrorFields(error) } } },
  };
};

export const collectOpenAIResponsesCompactionTurn = async (
  call: Promise<unknown>,
  answer: CompactionResponseFacts & { openaiResponses: GenerationOutcome },
  reader: CompactionReader,
): Promise<OpenAIResponsesCompactionTurn> => {
  const { openaiResponses: outcome, ...response } = answer;
  if (outcome.kind !== 'stream') return { call, answer, response, outcome };
  let result: OpenAIResponsesResultEx | undefined;
  const collected = await collectChatStream<OpenAIResponsesStreamEventEx, OpenAIResponsesResultEx>('openaiResponses', response.http, outcome.stream, reader, {
    accept(event) {
      if (event.type === 'response.completed' || event.type === 'response.incomplete') result = event.response;
    },
    finish() {
      return result === undefined
        ? compactionStreamFailure({ kind: 'protocol', cause: new Error(OPENAI_RESPONSES_MISSING_TERMINAL_MESSAGE) })
        : { kind: 'result', result };
    },
  }, compactionStreamFailure);
  return { call, answer, response: { ...response, http: collected.http }, outcome: collected.outcome };
};

export const dropOpenAIResponsesCompactionTurn = (
  { call, answer }: OpenAIResponsesCompactionTurn,
  scope: { abort(call: Promise<unknown>): void; discard(facts: Facts): void },
): void => {
  scope.abort(call);
  scope.discard(answer);
};

export const simulateOpenAIResponsesCompaction = async (
  payload: CanonicalOpenAIResponsesPayload,
  generate: CompactionGenerate,
  drop: DropCompactionTurn,
  warn: () => void,
): Promise<OpenAIResponsesCompactionTurn> => {
  const history = payload.input.filter(item => item.type !== 'compaction_trigger');
  const first = await generate({ ...payload, store: false, input: [...history, userMessage(CACHE_SHARING_SUMMARIZATION_PROMPT)] });
  if (first.outcome.kind === 'error') return first;
  const firstResult = first.outcome.result;
  const firstSummary = summaryTextFrom(firstResult.output);
  if (firstSummary.trim() !== '') {
    return { ...first, outcome: { kind: 'result', result: buildCompactionEnvelope(firstSummary, firstResult) } };
  }
  drop(first);
  warn();

  const fallback = await generate({
    ...payload,
    store: false,
    input: [
      { type: 'message', role: 'system', content: [{ type: 'input_text', text: SUMMARIZATION_PROMPT }] },
      ...history,
      userMessage('<system-reminder>Produce the handoff summary now per the instructions above.</system-reminder>'),
    ],
  });
  if (fallback.outcome.kind === 'error') return fallback;
  const fallbackResult = fallback.outcome.result;
  const summary = summaryTextFrom(fallbackResult.output);
  if (summary.trim() === '') throw new Error('OpenAI Responses compact shim: the summarization turn closed no assistant text to summarize');
  const usage = sumResponseUsage(firstResult.usage, fallbackResult.usage);
  const result = buildCompactionEnvelope(summary, { ...fallbackResult, ...(usage === undefined ? {} : { usage }) });
  return { ...fallback, outcome: { kind: 'result', result } };
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
  const output: OpenAIResponsesStoredItem[] = [];
  const encoder = new TextEncoder();
  let bytes = 0;
  const append = (item: OpenAIResponsesStoredItem): void => {
    bytes += encoder.encode(JSON.stringify(item)).byteLength;
    if (bytes > MAX_CHAT_COLLECTION_BYTES) {
      throw new RangeError(`OpenAI Responses compact decryption output exceeds the ${MAX_CHAT_COLLECTION_BYTES}-byte limit`);
    }
    output.push(item);
  };
  for (const item of original.output) {
    if (!isOpenAIResponsesCompactionItem(item) || typeof item.encrypted_content !== 'string') {
      append(item);
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
    drop(replay);
    const text = summaryTextFrom(replay.outcome.result.output);
    if (text.length === 0) throw new Error('OpenAI Responses compact decryption: the replay turn closed no assistant text');
    usage = sumResponseUsage(usage, replay.outcome.result.usage);
    append({ ...item, encrypted_content: encodeBoundedSummary(text) });
  }
  if (!sawCompaction) throw new Error('OpenAI Responses compact decryption: native compaction returned no compaction output item');
  return { ...native, outcome: { kind: 'result', result: { ...original, output, ...(usage === undefined ? {} : { usage }) } } };
};
