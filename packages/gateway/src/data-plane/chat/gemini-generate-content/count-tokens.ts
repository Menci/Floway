// Gemini generateContent's `:countTokens` as a pipeline.
//
//   emitGeminiGenerateContentTokenCount     the edge: writes the measurement, or the refusal, as one body
//   writeSettlement          above the fork, so a measurement is sampled once however many it tried
//   resolveChatCandidates    narrows to what can serve, in the order affinity asks for
//   failover                 runs what follows once per candidate
//   materializeAttempt       puts the payload this candidate is owed into the record
//   the three strippers      the same protocol-shape cleanups generation applies
//   measureGeminiGenerateContentAsAnthropicMessages  the pair: asks the question in Anthropic
//                                                    Messages and reads the answer back
//   the Anthropic Messages count wire                the ending, shared with
//                                                    `/v1/messages/count_tokens`
//
// A second **operation** over this protocol rather than another wire under
// `geminiGenerateContentServePipeline`, so it is a chain of its own. Like generation it has no wire of its
// own — the provider surface has no Gemini generateContent call — but unlike generation it has only one
// target: no protocol but Anthropic Messages answers "what would this cost", so there is nothing to
// pick between and the pair is in the array rather than under a fork.
//
// The pair is not `handOff`. A handoff maps frames, and there are none here: what crosses the
// protocol boundary is one measurement, and reading Anthropic's counts back out as Google's
// `{ totalTokens }` is the whole of the mapping. What it does share with a handoff is that it
// runs a translator, so it answers what the translator refuses — the same refusal, and the same
// 400, whichever action a client asked this protocol for.
//
// The strippers run for the reason they run on generation: what no translation can carry
// cannot be sent, so it goes at source. The thought suppressor does not — it rewrites a
// stream, and a measurement has none.

import { analyzeGeminiGenerateContentAffinity } from './affinity/ingress.ts';
import { renderGeminiGenerateContentError } from './errors.ts';
import type { GeminiGenerateContentFacts } from './pipeline.ts';
import { asJsonObject, readJsonNumber } from '../../../shared/json-helpers.ts';
import { isFailure, renderFailure } from '../../pipeline/facts.ts';
import { writeSettlement } from '../../pipeline/settlement.ts';
import { failover } from '../../pipeline/stages.ts';
import { isForwardableUpstreamHeader } from '../../shared/upstream-response.ts';
import { anthropicMessagesCountTokensWire, type TokenCountAnswer } from '../anthropic-messages/count-tokens.ts';
import {
  stripSafetySettingsFromGeminiGenerateContent,
  stripUnsupportedPartFieldsFromGeminiGenerateContent,
  stripUnsupportedToolsFromGeminiGenerateContent,
} from '../interceptors.ts';
import { chatTargetPicker } from '../shared/target-picker.ts';
import { materializeAttempt, resolveChatCandidates, type ChatNarrowing, type ChatServices } from '../stages.ts';
import { compose, defineStage, move, type Pipeline } from '@floway-dev/pipeline';
import type { GeminiGenerateContentPayload } from '@floway-dev/protocols/gemini-generate-content';
import { translateGeminiGenerateContentViaAnthropicMessages, TranslatorInputError } from '@floway-dev/translate';

/** Counting is reachable only over an upstream's own Anthropic Messages endpoint: no other protocol
 *  answers the question, and no translation invents an answer. */
export const geminiGenerateContentCountTokensTarget = chatTargetPicker(['anthropicMessages']);

type Counted<K extends 'response.chat.geminiGenerateContent' | 'response.chat.anthropicMessages'> = { [P in K]: TokenCountAnswer };

type G<K extends keyof GeminiGenerateContentFacts> = { [P in K]: GeminiGenerateContentFacts[P] };

/**
 * The outermost edge. A measurement is one object, so there is nothing to fold and nothing to
 * stream: what this decides is only whether the client is shown the count or the refusal that
 * stands in for it.
 */
const emitGeminiGenerateContentTokenCount = defineStage<
  Record<string, never>,
  Record<string, never>,
  Counted<'response.chat.geminiGenerateContent'> & G<'response.http.headers'>,
  G<'response.chat.geminiGenerateContent.rendered' | 'response.http.status' | 'response.http.headers'>,
  ChatServices
>({
  name: 'emitGeminiGenerateContentTokenCount',
  through: {
    request: { needs: [], consumes: [], provides: [] },
    response: {
      needs: ['response.chat.geminiGenerateContent', 'response.http.headers'],
      consumes: ['response.chat.geminiGenerateContent', 'response.http.headers'],
      provides: ['response.chat.geminiGenerateContent.rendered', 'response.http.status', 'response.http.headers'],
    },
  },
  execute: async (facts, next) => {
    const back = await next(facts);
    const { 'response.chat.geminiGenerateContent': answer, 'response.http.headers': headers, ...rest } = back;
    // Vendor traces and quota state stay visible; what an intermediary must strip, and what
    // would misdescribe a body this gateway serialized itself, does not. A filter that removed
    // nothing hands the same array on, so the record shows no change where none happened.
    const forwardable = headers.filter(([name]) => isForwardableUpstreamHeader(name));
    const forClient = forwardable.length === headers.length ? headers : move(forwardable);

    if (isFailure(answer)) {
      return {
        ...rest,
        'response.http.headers': forClient,
        'response.chat.geminiGenerateContent.rendered': move(renderFailure(answer, () => renderGeminiGenerateContentError(answer.status, answer.message))),
        'response.http.status': answer.status,
      };
    }
    return {
      ...rest,
      'response.http.headers': forClient,
      'response.chat.geminiGenerateContent.rendered': move(answer.body as Record<string, unknown>),
      'response.http.status': 200,
    };
  },
});

/**
 * Asks the question in Anthropic Messages, and reads the answer back out as Google's.
 *
 * It consumes this protocol's request key and provides the target's, exactly as a handoff
 * does, so the wire below sees only Anthropic Messages and cannot tell it was reached by translation.
 * What differs is the way back: there are no frames to map, only counts.
 *
 * It carries the `return` trait for the same reason a handoff does — a body the target
 * protocol cannot represent is answered here rather than measured.
 */
const measureGeminiGenerateContentAsAnthropicMessages = defineStage<
  G<'request.chat.geminiGenerateContent' | 'route.attempt'>,
  G<'request.chat.anthropicMessages'>,
  Counted<'response.chat.anthropicMessages'>,
  Counted<'response.chat.geminiGenerateContent'>,
  Counted<'response.chat.geminiGenerateContent'> & G<'response.usage.billable' | 'response.http.headers'>,
  ChatServices
>({
  name: 'measureGeminiGenerateContentAsAnthropicMessages',
  through: {
    request: {
      needs: ['request.chat.geminiGenerateContent', 'route.attempt'],
      consumes: ['request.chat.geminiGenerateContent'],
      provides: ['request.chat.anthropicMessages'],
    },
    response: {
      needs: ['response.chat.anthropicMessages'],
      consumes: ['response.chat.anthropicMessages'],
      provides: ['response.chat.geminiGenerateContent'],
    },
  },
  return: { provides: ['response.chat.geminiGenerateContent', 'response.usage.billable', 'response.http.headers'] },
  execute: async (facts, next, use) => {
    const candidate = use.resolveAttempt(facts['route.attempt']);
    const { 'request.chat.geminiGenerateContent': asked, ...down } = facts;

    let trip;
    try {
      trip = await translateGeminiGenerateContentViaAnthropicMessages(asked, {
        model: candidate.model.id,
        fallbackMaxOutputTokens: candidate.model.limits.max_output_tokens,
      });
    } catch (error) {
      // Input the counting wire's protocol cannot represent is the client's fault, and the
      // translator is what knows which part of the body was at fault. Answering rather than
      // throwing is also what keeps it a *candidate's* verdict, so the fork can try the next
      // one. Anything else raised here is a fault of this gateway's and rides up as one.
      if (!(error instanceof TranslatorInputError)) throw error;
      return move({
        ...down,
        'response.chat.geminiGenerateContent': { status: 400, message: error.message },
        // Nothing was measured, which is what an empty billed set and an empty header list say
        // on the other two keys. There is no streamed reading to leave behind: a measurement
        // never opens a stream, which is why this chain carries no such key at all.
        'response.usage.billable': [],
        'response.http.headers': [],
      });
    }

    // The translator writes a turn, and a turn says how its answer is delivered. There is no
    // answer to deliver here, so the field does not travel.
    const { stream: _stream, ...target } = trip.target;

    const back = await next({ ...down, 'request.chat.anthropicMessages': move(target) });
    const { 'response.chat.anthropicMessages': counted, ...up } = back;
    return { ...up, 'response.chat.geminiGenerateContent': move(asGeminiGenerateContentTokenCount(counted)) };
  },
});

/**
 * Anthropic's counts, as Google states them.
 *
 * The upstream body is provider-specific: Anthropic's own endpoint answers `input_tokens`,
 * and a Copilot upstream's translated count answers `total_tokens`. Either is the number this
 * protocol calls `totalTokens`; a body carrying neither is an answer this gateway cannot
 * read, which is the gateway failing to serve rather than anything the client can fix.
 */
const asGeminiGenerateContentTokenCount = (counted: TokenCountAnswer): TokenCountAnswer => {
  if (isFailure(counted)) {
    return {
      ...counted,
      // An upstream that refused with an empty body left nothing to quote, and a refusal that
      // says nothing at all is not one a caller can act on.
      message: counted.message === '' ? 'Upstream token counting request failed.' : counted.message,
    };
  }
  const body = asJsonObject(counted.body);
  const totalTokens = readJsonNumber(body?.input_tokens) ?? readJsonNumber(body?.total_tokens);
  if (totalTokens === null) return { status: 502, message: 'Invalid upstream token counting response.' };
  return { kind: 'value', body: { totalTokens } };
};

/** A candidate that cannot serve *this* request is not a candidate — and what the client's
 *  own turn carries decides the order the rest are tried in, which is why the narrowing is
 *  built from the request rather than being a constant. */
const narrowing = (payload: GeminiGenerateContentPayload): ChatNarrowing<Counted<'response.chat.geminiGenerateContent'>> => ({
  canServe: candidate => geminiGenerateContentCountTokensTarget.canServe(candidate.model.endpoints),
  affinity: async gateway => await analyzeGeminiGenerateContentAffinity(payload, gateway.affinity.codec),
  unsupported: model => `Model ${model} does not support countTokens.`,
  refuse: (status, message) => ({ 'response.chat.geminiGenerateContent': { status, message } }),
  refuses: ['response.chat.geminiGenerateContent'],
});

export type GeminiGenerateContentCountTokensEntry = G<
  'ingress.http.headers' | 'ingress.chat.sourceProtocol' | 'request.chat.geminiGenerateContent' | 'serve.model'
>;

export type GeminiGenerateContentCountTokensExit = G<
  'response.chat.geminiGenerateContent.rendered' | 'response.http.status' | 'response.http.headers'
>;

export const geminiGenerateContentCountTokensPipeline = (payload: GeminiGenerateContentPayload): Pipeline<GeminiGenerateContentCountTokensEntry, GeminiGenerateContentCountTokensExit> =>
  compose('geminiGenerateContentCountTokens', [
    emitGeminiGenerateContentTokenCount,
    // A measurement goes through settlement like every other run. It provides an empty
    // billed set because nothing here is billable today, not because the operation is
    // exempt — an upstream that began charging for it would provide a non-empty one and
    // nothing else would change.
    writeSettlement(handedUp => isFailure((handedUp as { 'response.chat.geminiGenerateContent'?: unknown })['response.chat.geminiGenerateContent'])),
    resolveChatCandidates(narrowing(payload)),
    failover({
      failed: handedUp => isFailure((handedUp as { 'response.chat.geminiGenerateContent'?: unknown })['response.chat.geminiGenerateContent']),
      owns: [],
    }),
    materializeAttempt('request.chat.geminiGenerateContent'),
    stripUnsupportedPartFieldsFromGeminiGenerateContent,
    stripUnsupportedToolsFromGeminiGenerateContent,
    stripSafetySettingsFromGeminiGenerateContent,
    measureGeminiGenerateContentAsAnthropicMessages,
    ...anthropicMessagesCountTokensWire,
  ]);
