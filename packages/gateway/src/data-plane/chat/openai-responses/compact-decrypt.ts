import { encodeShimCompactionPayload, EXACT_REPEAT_PREFIX, EXACT_REPEAT_SUFFIX, summaryTextFrom, sumResponseUsage } from './compact-shim.ts';
import { internalErrorEnvelope } from './errors.ts';
import { syntheticEventsFromCompaction, syntheticEventsFromResult } from './items/output.ts';
import type { BillableEntity } from '../../pipeline/facts.ts';
import { isFailure } from '../../pipeline/facts.ts';
import type { StreamOutcome } from '../../pipeline/serve.ts';
import type { ChatFacts, ChatAnswer } from '../facts.ts';
import type { ChatServices } from '../services.ts';
import type { ChatWire } from '../wire.ts';
import { defer, defineStage, move, type Deferred } from '@floway-dev/pipeline';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import {
  collectOpenAIResponsesProtocolEventsToResult,
  isOpenAIResponsesCompactionItem,
  type CanonicalOpenAIResponsesPayload,
  type OpenAIResponsesOutputItem,
  type OpenAIResponsesResult,
  type OpenAIResponsesStreamEvent,
} from '@floway-dev/protocols/openai-responses';

type Request = Pick<ChatFacts, 'request.chat.openaiResponses' | 'route.attempt' | 'ingress.http.headers' | 'ingress.chat.sourceProtocol'>;
type Answer = Pick<ChatFacts, 'response.chat.openaiResponses' | 'response.usage.billable' | 'response.http.headers'> & Record<string, unknown>;

export const decryptNativeCompaction = (spec: {
  native: ChatWire;
  replay: ChatWire;
  streamedUsage: string;
  compactEndpoint: boolean;
  asked: (payload: CanonicalOpenAIResponsesPayload) => boolean;
}) => defineStage<Request, Request, Answer, Answer, ChatServices>({
  name: 'decryptNativeCompaction',
  into: {
    request: { needs: ['request.chat.openaiResponses', 'route.attempt', 'ingress.http.headers', 'ingress.chat.sourceProtocol'], consumes: [], provides: ['request.chat.openaiResponses'] },
    response: {
      needs: ['response.chat.openaiResponses', spec.streamedUsage, 'response.usage.billable', 'response.http.headers'],
      consumes: [],
      provides: ['response.chat.openaiResponses', spec.streamedUsage, 'response.usage.billable'],
    },
  },
  execute: async (facts, next, use) => {
    const payload = facts['request.chat.openaiResponses'] as CanonicalOpenAIResponsesPayload;
    const initial = await next(facts, spec.native as never);
    if (!facts['route.attempt'].flags.includes('openai-responses-compact-decrypt') || !spec.asked(payload)) return initial;
    const answer = initial['response.chat.openaiResponses'];
    if (isFailure(answer)) return initial;

    const billed: BillableEntity[] = [];
    let failed = false;
    const collect = async (back: Answer): Promise<OpenAIResponsesResult> => {
      const response = back['response.chat.openaiResponses'] as Exclude<ChatAnswer, import('../../pipeline/facts.ts').Failure>;
      try {
        if (response.kind === 'value') return response.body as OpenAIResponsesResult;
        return await collectOpenAIResponsesProtocolEventsToResult(response.frames as AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEvent>>);
      } finally {
        const pending = back[spec.streamedUsage] as Deferred<StreamOutcome> | null;
        if (pending === null) billed.push(...back['response.usage.billable']);
        else {
          const outcome = await pending;
          billed.push(...outcome.billable);
          failed ||= outcome.failed;
        }
      }
    };
    const returned = (back: Answer, response: ChatAnswer, fault: boolean): Answer => ({
      ...back,
      'response.chat.openaiResponses': move(response),
      'response.usage.billable': move(billed),
      [spec.streamedUsage]: isFailure(response) ? null : move(defer(Promise.resolve({ billable: billed, failed: failed || fault }))),
    });

    try {
      const native = await collect(initial);
      let usage = native.usage;
      let sawCompaction = false;
      const output: OpenAIResponsesOutputItem[] = [];
      for (const item of native.output) {
        if (!isOpenAIResponsesCompactionItem(item)) { output.push(item); continue; }
        sawCompaction = true;
        use.gateway.abortSignal?.throwIfAborted();
        const replayPayload: CanonicalOpenAIResponsesPayload = {
          model: payload.model,
          input: [
            { type: 'message', role: 'system', content: [{ type: 'input_text', text: EXACT_REPEAT_PREFIX }] },
            item,
            { type: 'message', role: 'system', content: [{ type: 'input_text', text: EXACT_REPEAT_SUFFIX }] },
          ],
          store: false,
        };
        const replay = await next({ ...facts, 'request.chat.openaiResponses': move(replayPayload) }, spec.replay as never);
        const replayAnswer = replay['response.chat.openaiResponses'];
        if (isFailure(replayAnswer)) {
          billed.push(...replay['response.usage.billable']);
          return returned(replay, replayAnswer, true);
        }
        const response = await collect(replay);
        const text = summaryTextFrom(response.output);
        if (text.length === 0) throw new Error('OpenAI Responses compact decryption: the replay turn closed no assistant text');
        usage = sumResponseUsage(usage, response.usage);
        output.push({ ...item, encrypted_content: encodeShimCompactionPayload(text) });
      }
      if (!sawCompaction) throw new Error('OpenAI Responses compact decryption: native compaction returned no compaction item');
      const result = { ...native, ...(!spec.compactEndpoint ? { object: 'response' as const } : {}), output, ...(usage === undefined ? {} : { usage }) };
      return returned(initial, { kind: 'stream', frames: spec.compactEndpoint ? syntheticEventsFromCompaction(result) : syntheticEventsFromResult(result) }, false);
    } catch (error) {
      const envelope = internalErrorEnvelope(error);
      return returned(initial, { status: 500, message: envelope.error.message, envelope }, true);
    }
  },
});
