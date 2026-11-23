import { type ResponsesBodyBack, type ResponsesBodyFacts, responsesBodyRequest } from './facts.ts';
import { mergeBillableCalls, type UsageFacts } from '../../../pipeline/observe-usage.ts';
import { CACHE_SHARING_SUMMARIZATION_PROMPT, encodeShimCompactionPayload, EXACT_REPEAT_PREFIX, EXACT_REPEAT_SUFFIX, expandShimCompactionItems, SUMMARIZATION_PROMPT, SUMMARY_PREFIX } from '../compact-payload.ts';
import { syntheticEventsFromCompaction, syntheticEventsFromResult } from '../items/output.ts';
import { defineStage, type Next, type StageEnv } from '@floway-dev/pipeline';
import { collectOpenAIResponsesProtocolEventsToResult, createRandomOpenAIResponsesItemId, isOpenAIResponsesCompactionItem, type CanonicalOpenAIResponsesInputItem, type OpenAIResponsesCompactionResultEx, type OpenAIResponsesOutputItemEx, type OpenAIResponsesResultEx } from '@floway-dev/protocols/openai-responses';
import type { OpenAIResponsesAction } from '@floway-dev/provider';

interface Request extends ResponsesBodyFacts {
  readonly 'request.action': OpenAIResponsesAction;
}

type NextTurn = Next<Request, ResponsesBodyBack>;

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

const eventsForCompaction = (env: StageEnv, response: OpenAIResponsesCompactionResultEx | OpenAIResponsesResultEx) =>
  env.createStream({
    label: 'compaction events',
    iterate: () => syntheticEventsFromCompaction(response),
  });

const mergeCalls = (env: StageEnv, back: ResponsesBodyBack, calls: readonly UsageFacts['response.usage.billable'][]): ResponsesBodyBack => ({
  ...back,
  'response.usage.billable': env.defer('compaction calls', mergeBillableCalls(calls)),
});

const simulateCompaction = async (facts: Request, next: NextTurn, env: StageEnv): Promise<ResponsesBodyBack> => {
  const payload = facts['request.openaiResponses'];
  const history = payload.input.filter(item => item.type !== 'compaction_trigger');
  const runGenerate = (input: CanonicalOpenAIResponsesInputItem[]) => next({
    ...facts,
    'request.action': 'generate',
    'request.openaiResponses': { ...payload, input, store: false },
  });
  const first = await runGenerate([...history, summarizationUserMessage(CACHE_SHARING_SUMMARIZATION_PROMPT)]);
  if (first['response.openaiResponses'] === undefined) return first;

  const firstResult = await collectOpenAIResponsesProtocolEventsToResult(first['response.openaiResponses']);
  let response = firstResult;
  let text = summaryTextFrom(response.output);
  let base = first;
  if (text.trim().length === 0) {
    env.log.warn('Floway: OpenAI Responses compact shim cache-sharing summarization returned no assistant text; retrying with the legacy system-prompt summarizer');
    const fallback = await runGenerate([
      { type: 'message', role: 'system', content: [{ type: 'input_text', text: SUMMARIZATION_PROMPT }] },
      ...history,
      summarizationUserMessage('<system-reminder>Produce the handoff summary now per the instructions above.</system-reminder>'),
    ]);
    base = mergeCalls(env, fallback, [first['response.usage.billable'], fallback['response.usage.billable']]);
    if (fallback['response.openaiResponses'] === undefined) return base;

    const fallbackResult = await collectOpenAIResponsesProtocolEventsToResult(fallback['response.openaiResponses']);
    text = summaryTextFrom(fallbackResult.output);
    if (text.trim().length === 0) {
      throw new Error('OpenAI Responses compact shim: the summarization turn closed no assistant text to summarize');
    }
    const combinedUsage = sumResponseUsage(firstResult.usage, fallbackResult.usage);
    response = { ...fallbackResult, ...(combinedUsage === undefined ? {} : { usage: combinedUsage }) };
  }

  const compaction = {
    ...response,
    id: `resp_compact_shim_${crypto.randomUUID()}`,
    object: 'response.compaction',
    output: [{
      type: 'compaction' as const,
      id: createRandomOpenAIResponsesItemId('compaction'),
      encrypted_content: encodeShimCompactionPayload(`${SUMMARY_PREFIX}\n${text}`),
    }],
  };
  return {
    ...base,
    'response.openaiResponses': env.createStream({ label: 'compaction events', iterate: () => syntheticEventsFromResult(compaction) }),
  };
};

const decryptNativeCompaction = async (facts: Request, next: NextTurn, env: StageEnv): Promise<ResponsesBodyBack> => {
  const native = await next(facts);
  const events = native['response.openaiResponses'];
  const result = events === undefined ? native['response.result'] : await collectOpenAIResponsesProtocolEventsToResult(events);
  if (result === undefined) return native;

  const calls = [native['response.usage.billable']];
  let usage = result.usage;
  const output: OpenAIResponsesCompactionResultEx['output'] = [];
  for (const item of result.output) {
    if (!isOpenAIResponsesCompactionItem(item) || typeof item.encrypted_content !== 'string') {
      output.push(item);
      continue;
    }
    const replay = await next({
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
    calls.push(replay['response.usage.billable']);
    if (replay['response.openaiResponses'] === undefined) return mergeCalls(env, replay, calls);
    const replayResult = await collectOpenAIResponsesProtocolEventsToResult(replay['response.openaiResponses']);
    const text = summaryTextFrom(replayResult.output);
    if (text.length === 0) throw new Error('OpenAI Responses compact decryption: the replay turn closed no assistant text');
    usage = sumResponseUsage(usage, replayResult.usage);
    output.push({ ...item, encrypted_content: encodeShimCompactionPayload(text) });
  }
  if (calls.length === 1) throw new Error('OpenAI Responses compact decryption: native compaction returned no compaction output item');

  const base = mergeCalls(env, native, calls);
  if (events === undefined) {
    return { ...base, 'response.result': { ...result, output, ...(usage === undefined ? {} : { usage }) } };
  }
  const response = { ...result, output, ...(usage === undefined ? {} : { usage }) };
  return {
    ...base,
    'response.openaiResponses': facts['request.action'] === 'compact'
      ? eventsForCompaction(env, response)
      : env.createStream({ label: 'decrypted compaction events', iterate: () => syntheticEventsFromResult(response as OpenAIResponsesResultEx) }),
  };
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
      needs: ['response.openaiResponses', 'response.usage.billable'],
      consumes: [],
      provides: ['response.openaiResponses', 'response.result', 'response.usage.billable'],
    },
  },
  execute: async (facts, next, env) => {
    const payload = expandShimCompactionItems(facts['request.openaiResponses']);
    const request = { ...facts, 'request.openaiResponses': payload };
    const flags = facts['route.candidate'].providerModel.enabledFlags;
    if (facts['request.action'] === 'compact' || containsCompactionTrigger(payload.input)) {
      if (facts['route.targetApi'] !== 'openaiResponses' || flags.includes('openai-responses-compact-shim')) {
        const back = await simulateCompaction(request, next, env);
        return { ...back, 'response.result': back['response.result'] };
      }
      if (flags.includes('openai-responses-compact-decrypt')) {
        const back = await decryptNativeCompaction(request, next, env);
        return { ...back, 'response.result': back['response.result'] };
      }
    }
    const back = await next(request);
    return { ...back, 'response.result': back['response.result'] };
  },
});
