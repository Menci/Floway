import { type ResponsesBodyBack, type ResponsesBodyFacts, responsesBodyRequest } from './facts.ts';
import { CACHE_SHARING_SUMMARIZATION_PROMPT, encodeShimCompactionPayload, EXACT_REPEAT_PREFIX, EXACT_REPEAT_SUFFIX, expandShimCompactionItems, SUMMARIZATION_PROMPT, SUMMARY_PREFIX } from '../compact-payload.ts';
import { collectFailure } from '../encode.ts';
import { syntheticEventsFromCompaction } from '../items/output.ts';
import { isTransportFailure } from '@floway-dev/http';
import { defineStage, type FactValue, type StageScope } from '@floway-dev/pipeline';
import { createRandomOpenAIResponsesItemId, isOpenAIResponsesCompactionItem, OPENAI_RESPONSES_MISSING_TERMINAL_MESSAGE, type CanonicalOpenAIResponsesInputItem, type OpenAIResponsesCompactionResultEx, type OpenAIResponsesResultEx, type OpenAIResponsesStreamEventEx, type OpenAIResponsesStoredItem } from '@floway-dev/protocols/openai-responses';
import type { OpenAIResponsesAction } from '@floway-dev/provider';

interface Request extends ResponsesBodyFacts {
  readonly 'request.action': OpenAIResponsesAction;
}

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

const summarizationUserMessage = (text: string): CanonicalOpenAIResponsesInputItem => ({
  type: 'message',
  role: 'user',
  content: [{ type: 'input_text', text }],
});

type TurnScope = Pick<StageScope<Request, ResponsesBodyBack>, 'next' | 'log' | 'createStream'>;

const collectTurn = async (back: ResponsesBodyBack): Promise<
  { readonly kind: 'result'; readonly result: OpenAIResponsesCompactionResultEx } |
  { readonly kind: 'error'; readonly response: ResponsesBodyBack }
> => {
  const outcome = back['response.openaiResponses'];
  if (outcome.kind === 'error') return { kind: 'error', response: back };
  if (outcome.kind === 'result') return outcome;
  const http = back['response.http'];
  let error: Extract<OpenAIResponsesStreamEventEx, { type: 'error' }> | undefined;
  for await (const frame of outcome.events) {
    if (isTransportFailure(frame)) {
      return {
        kind: 'error',
        response: {
          ...back,
          'response.http': { ...http, status: 502, statusText: '', transportError: frame.error },
          'response.openaiResponses': { kind: 'error', source: 'upstream', error: frame.error },
        },
      };
    }
    if (frame.type === 'done') continue;
    const event = frame.event;
    if (event.type === 'error') error = event;
    if (event.type === 'response.completed' || event.type === 'response.incomplete' || event.type === 'response.failed') {
      if (event.type === 'response.failed' && error !== undefined) break;
      return { kind: 'result', result: event.response };
    }
  }
  const failure = error === undefined
    ? collectFailure(new Error(OPENAI_RESPONSES_MISSING_TERMINAL_MESSAGE))
    : collectFailure(new Error('OpenAI Responses compaction received a protocol error', { cause: error }));
  return {
    kind: 'error',
    response: {
      ...back,
      'response.http': { ...http, status: failure.status, statusText: '' },
      'response.openaiResponses': { kind: 'error', source: 'upstream', error: failure.body as FactValue },
    },
  };
};

const simulateCompaction = async (facts: Request, scope: TurnScope): Promise<ResponsesBodyBack> => {
  const payload = facts['request.openaiResponses'];
  const history = payload.input.filter(item => item.type !== 'compaction_trigger');
  const runGenerate = (input: CanonicalOpenAIResponsesInputItem[]) => scope.next({
    ...facts,
    'request.action': 'generate',
    'request.openaiResponses': { ...payload, input, store: false },
  });
  const first = await runGenerate([...history, summarizationUserMessage(CACHE_SHARING_SUMMARIZATION_PROMPT)]);
  const collected = await collectTurn(first);
  if (collected.kind === 'error') return collected.response;

  let response = collected.result;
  let text = summaryTextFrom(response.output);
  let base = first;
  if (text.trim().length === 0) {
    scope.log.warn('Floway: OpenAI Responses compact shim cache-sharing summarization returned no assistant text; retrying with the legacy system-prompt summarizer');
    const fallback = await runGenerate([
      { type: 'message', role: 'system', content: [{ type: 'input_text', text: SUMMARIZATION_PROMPT }] },
      ...history,
      summarizationUserMessage('<system-reminder>Produce the handoff summary now per the instructions above.</system-reminder>'),
    ]);
    base = fallback;
    const fallbackResult = await collectTurn(fallback);
    if (fallbackResult.kind === 'error') return fallbackResult.response;
    text = summaryTextFrom(fallbackResult.result.output);
    if (text.trim().length === 0) {
      throw new Error('OpenAI Responses compact shim: the summarization turn closed no assistant text to summarize');
    }
    const combinedUsage = sumResponseUsage(response.usage, fallbackResult.result.usage);
    response = { ...fallbackResult.result, ...(combinedUsage === undefined ? {} : { usage: combinedUsage }) };
  }

  const result = {
    ...response,
    id: `resp_compact_shim_${crypto.randomUUID()}`,
    object: 'response.compaction',
    output: [{
      type: 'compaction' as const,
      id: createRandomOpenAIResponsesItemId('compaction'),
      encrypted_content: encodeShimCompactionPayload(`${SUMMARY_PREFIX}\n${text}`),
    }],
  };
  return answerCompaction(facts, scope, base, result);
};

const answerCompaction = (
  facts: Request, scope: TurnScope, base: ResponsesBodyBack, result: OpenAIResponsesCompactionResultEx,
): ResponsesBodyBack => ({
  ...base,
  'response.openaiResponses': facts['request.action'] === 'compact'
    ? { kind: 'result', result }
    : { kind: 'stream', events: scope.createStream({ label: 'compaction events', iterate: () => syntheticEventsFromCompaction(result) }) },
});

const decryptNativeCompaction = async (facts: Request, scope: TurnScope): Promise<ResponsesBodyBack> => {
  const native = await scope.next(facts);
  const collected = await collectTurn(native);
  if (collected.kind === 'error') return collected.response;
  const { result } = collected;

  let replayed = false;
  let usage = result.usage;
  const output: OpenAIResponsesCompactionResultEx['output'] = [];
  for (const item of result.output) {
    if (!isOpenAIResponsesCompactionItem(item) || typeof item.encrypted_content !== 'string') {
      output.push(item);
      continue;
    }
    const replay = await scope.next({
      ...facts,
      'request.action': 'generate',
      'request.openaiResponses': {
        model: facts['request.openaiResponses'].model,
        input: [
          { type: 'message', role: 'system', content: [{ type: 'input_text', text: EXACT_REPEAT_PREFIX }] },
          item,
          { type: 'message', role: 'system', content: [{ type: 'input_text', text: EXACT_REPEAT_SUFFIX }] },
        ],
        store: false,
      },
    });
    replayed = true;
    const replayResult = await collectTurn(replay);
    if (replayResult.kind === 'error') return replayResult.response;
    const text = summaryTextFrom(replayResult.result.output);
    if (text.length === 0) throw new Error('OpenAI Responses compact decryption: the replay turn closed no assistant text');
    usage = sumResponseUsage(usage, replayResult.result.usage);
    output.push({ ...item, encrypted_content: encodeShimCompactionPayload(text) });
  }
  if (!replayed) throw new Error('OpenAI Responses compact decryption: native compaction returned no compaction output item');

  return answerCompaction(facts, scope, native, { ...result, output, ...(usage === undefined ? {} : { usage }) });
};

export const containsCompactionTrigger = (input: readonly CanonicalOpenAIResponsesInputItem[]): boolean =>
  input.some(item => item.type === 'compaction_trigger');

export const compactShim = defineStage<Request, Request, ResponsesBodyBack, ResponsesBodyBack>({
  name: 'compactShim',
  through: {
    request: {
      ...responsesBodyRequest,
      needs: [...responsesBodyRequest.needs, 'request.action'],
      provides: [...responsesBodyRequest.provides, 'request.action'],
    },
    response: {
      needs: ['response.http', 'response.openaiResponses'],
      consumes: [],
      provides: ['response.http', 'response.openaiResponses'],
    },
  },
  execute: async (facts, scope) => {
    const payload = expandShimCompactionItems(facts['request.openaiResponses']);
    const request = { ...facts, 'request.openaiResponses': payload };
    const flags = facts['route.candidate'].providerModel.enabledFlags;
    if (facts['request.action'] === 'compact' || containsCompactionTrigger(payload.input)) {
      if (facts['route.targetApi'] !== 'openaiResponses' || flags.includes('openai-responses-compact-shim')) {
        return await simulateCompaction(request, scope);
      }
      if (flags.includes('openai-responses-compact-decrypt')) {
        return await decryptNativeCompaction(request, scope);
      }
    }
    return await scope.next(request);
  },
});
