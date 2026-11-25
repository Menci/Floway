import { expandOpenAIResponsesCompactionItems, packOpenAIResponsesCompactionText, summaryRetryInput, summaryInput, sumOpenAIResponsesUsage, SUMMARY_PREFIX } from './compact/items.ts';
import { openAIResponsesExit, openAIResponsesFactSpace } from './facts.ts';
import { openAIResponsesTargetFor } from './target.ts';
import type { GatewayPipelineFacts } from '../../../pipeline/facts.ts';
import { providerSupportsOperation } from '../../../pipeline/provider-pipelines.ts';
import { responseHead } from '../../../pipeline/response.ts';
import { openaiInternalErrorPayload } from '../../../shared/openai-errors.ts';
import { collectChatOutcome } from '../../pipeline/collect.ts';
import { syntheticEventsFromResult } from '../items/output.ts';
import { move } from '@floway-dev/pipeline';
import { collectOpenAIResponsesProtocolEventsToResult, createRandomOpenAIResponsesItemId, isOpenAIResponsesCompactionItem, type CanonicalOpenAIResponsesPayload, type OpenAIResponsesCompactionResultEx, type OpenAIResponsesResultEx, type OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import { toInternalDebugError, type ProtocolStreamError } from '@floway-dev/provider';

const { defineStage } = openAIResponsesFactSpace<{}>();

const declarations = ['request.openaiResponses', 'request.openaiResponsesAction'] as const;
type Answer = Pick<GatewayPipelineFacts, typeof openAIResponsesExit[number]>;
type ScalarAnswer = { readonly kind: 'result'; readonly result: OpenAIResponsesResultEx | OpenAIResponsesCompactionResultEx };

export const compactOpenAIResponses = defineStage({
  name: 'openaiResponses.compact',
  through: {
    request: { needs: [...declarations, 'serve.candidate'], provides: declarations, consumes: [] },
    response: { needs: openAIResponsesExit, provides: openAIResponsesExit, consumes: [] },
  },
  async execute(facts, scope) {
    const action = facts['request.openaiResponsesAction'];
    const payload = expandOpenAIResponsesCompactionItems(facts['request.openaiResponses']);
    const candidate = facts['serve.candidate'];
    const compact = action === 'compact' || payload.input.some(item => item.type === 'compaction_trigger');
    const flags = candidate.model.enabledFlags;
    const native = openAIResponsesTargetFor(candidate) === 'openaiResponses'
      && (action !== 'compact' || providerSupportsOperation(candidate.upstream.kind, 'openaiResponsesCompact'));
    const simulate = compact && (!native || flags.includes('openai-responses-compact-shim'));
    const decrypt = compact && !simulate && flags.includes('openai-responses-compact-decrypt');
    const call = (request: CanonicalOpenAIResponsesPayload, innerAction: typeof action) => scope.next({
      ...facts,
      'request.openaiResponses': move(request),
      'request.openaiResponsesAction': innerAction,
    });

    const collect = async (pending: Promise<Answer>): Promise<Answer> => {
      const back = await pending;
      const outcome = back['response.openaiResponses'];
      if (outcome.kind !== 'stream') return back;
      const collected = await collectChatOutcome(outcome.stream, { abort: () => { scope.abort(pending); } },
        collectOpenAIResponsesProtocolEventsToResult, (_message, cause) => openaiInternalErrorPayload(toInternalDebugError(cause)));
      return {
        ...back,
        ...(collected.kind === 'error' && { 'response.http': move(responseHead(502)) }),
        'response.openaiResponses': move(collected),
      };
    };

    const deliver = (back: Answer, result: ScalarAnswer['result']): Answer => {
      if (action === 'compact') return { ...back, 'response.openaiResponses': move({ kind: 'result', result } as const) };
      if (!('status' in result)) throw new TypeError('OpenAI Responses compaction trigger returned a resource without status');
      const stream = scope.createStream<OpenAIResponsesStreamEventEx, ProtocolStreamError>(async function* () {
        for await (const frame of syntheticEventsFromResult(result)) {
          if (frame.type === 'event') yield { ok: true, value: frame.event } as const;
        }
      });
      return { ...back, 'response.openaiResponses': move({ kind: 'stream', stream } as const) };
    };

    if (simulate) {
      const history = payload.input.filter(item => item.type !== 'compaction_trigger');
      const generate = (input: CanonicalOpenAIResponsesPayload['input']) => collect(call({ ...payload, input, store: false }, 'generate'));
      const first = await generate(summaryInput(history));
      const firstOutcome = first['response.openaiResponses'];
      if (firstOutcome.kind === 'error') return first;
      const firstResponse = generationResult(firstOutcome);
      let text = summaryText(firstResponse);
      if (text.trim().length > 0) return deliver(first, compaction(firstResponse, text));

      scope.log.warn('Floway: OpenAI Responses compact cache-sharing summarization returned no assistant text; retrying with the system prompt');
      const retry = await generate(summaryRetryInput(history));
      const retryOutcome = retry['response.openaiResponses'];
      if (retryOutcome.kind === 'error') return retry;
      const secondResponse = generationResult(retryOutcome);
      text = summaryText(secondResponse);
      if (text.trim().length === 0) {
        throw new Error('OpenAI Responses compact: the summarization turn closed no assistant text to summarize');
      }
      const usage = sumOpenAIResponsesUsage(firstResponse.usage, secondResponse.usage);
      return deliver(retry, compaction({ ...secondResponse, ...(usage !== undefined && { usage }) }, text));
    }

    const pending = call(payload, action);
    if (!decrypt) return await pending;

    const nativeAnswer = await collect(pending);
    const nativeOutcome = nativeAnswer['response.openaiResponses'];
    if (nativeOutcome.kind === 'error') return nativeAnswer;
    if (nativeOutcome.kind !== 'result') throw new TypeError('OpenAI Responses compact collection returned a stream');
    const nativeResult = nativeOutcome.result;
    const output: OpenAIResponsesCompactionResultEx['output'] = [];
    let usage = nativeResult.usage;
    let decrypted = false;
    for (const item of nativeResult.output) {
      if (!isOpenAIResponsesCompactionItem(item) || !('encrypted_content' in item) || typeof item.encrypted_content !== 'string') {
        output.push(item);
        continue;
      }
      const replay = await collect(call({
        model: payload.model,
        input: [
          { type: 'message', role: 'system', content: [{ type: 'input_text', text: EXACT_REPEAT_PREFIX }] },
          item,
          { type: 'message', role: 'system', content: [{ type: 'input_text', text: EXACT_REPEAT_SUFFIX }] },
        ],
        store: false,
      }, 'generate'));
      const replayOutcome = replay['response.openaiResponses'];
      if (replayOutcome.kind === 'error') return replay;
      const replayResult = generationResult(replayOutcome);
      const text = summaryText(replayResult);
      if (text.length === 0) throw new Error('OpenAI Responses compact decryption: the replay turn closed no assistant text');
      usage = sumOpenAIResponsesUsage(usage, replayResult.usage);
      output.push({ ...item, encrypted_content: packOpenAIResponsesCompactionText(text) });
      decrypted = true;
    }
    if (!decrypted) throw new Error('OpenAI Responses compact decryption: native compaction returned no compaction output item');
    const fields = usage === undefined ? {} : { usage };
    if ('status' in nativeResult) {
      // Generation compaction supplies a response resource and output items;
      // every rewrite above keeps the original item type.
      return deliver(nativeAnswer, { ...nativeResult, ...fields, output: output as OpenAIResponsesResultEx['output'] });
    }
    return deliver(nativeAnswer, { ...nativeResult, ...fields, output });
  },
});

const EXACT_REPEAT_PREFIX = 'Repeat the following text exactly, which may contain a compaction summary, character for character.';
const EXACT_REPEAT_SUFFIX = 'Output only the exact summary text, with no preface, explanation, markdown fence, or changes.';

const generationResult = (outcome: Exclude<Answer['response.openaiResponses'], { readonly kind: 'error' }>): OpenAIResponsesResultEx => {
  if (outcome.kind !== 'result' || !('status' in outcome.result)) {
    throw new TypeError('OpenAI Responses summarization requires a collected generation result');
  }
  return outcome.result;
};

const summaryText = ({ output }: OpenAIResponsesResultEx): string => output.flatMap(item =>
  item.type === 'message' ? item.content.flatMap(block => block.type === 'output_text' ? [block.text] : []) : []).join('');

const compaction = (upstream: OpenAIResponsesResultEx, text: string): OpenAIResponsesResultEx => ({
  ...upstream,
  id: `resp_compact_shim_${crypto.randomUUID()}`,
  object: 'response.compaction',
  output: [{
    type: 'compaction',
    id: createRandomOpenAIResponsesItemId('compaction'),
    encrypted_content: packOpenAIResponsesCompactionText(`${SUMMARY_PREFIX}\n${text}`),
  }] as OpenAIResponsesResultEx['output'],
});
