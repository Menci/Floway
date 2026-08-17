// Gemini's `:countTokens` as a pipeline.
//
//   emitGeminiTokenCount     the edge: writes the measurement, or the refusal, as one body
//   resolveChatCandidates    narrows to what can serve, in the order affinity asks for
//   failover                 runs what follows once per candidate
//   materializeAttempt       puts the payload this candidate is owed into the record
//   the three strippers      the same protocol-shape cleanups generation applies
//   measureGeminiAsMessages  the pair: asks the question in Messages and reads the answer back
//   the Messages count wire  the ending, shared with `/v1/messages/count_tokens`
//
// A second **operation** over this protocol rather than another wire under
// `geminiServePipeline`, so it is a chain of its own. Like generation it has no wire of its
// own — the provider surface has no Gemini call — but unlike generation it has only one
// target: no protocol but Messages answers "what would this cost", so there is nothing to
// pick between and the pair is in the array rather than under a fork.
//
// The pair is not `handOff`. A handoff maps frames, and there are none here: what crosses the
// protocol boundary is one measurement, and reading Anthropic's counts back out as Google's
// `{ totalTokens }` is the whole of the mapping.
//
// The strippers run for the reason they run on generation: what no translation can carry
// cannot be sent, so it goes at source. The thought suppressor does not — it rewrites a
// stream, and a measurement has none.

import { analyzeGeminiAffinity } from './affinity/ingress.ts';
import { renderGeminiError } from './errors.ts';
import type { GeminiFacts } from './pipeline.ts';
import { asJsonObject, readJsonNumber } from '../../../shared/json-helpers.ts';
import { isFailure } from '../../pipeline/facts.ts';
import { writeSettlement } from '../../pipeline/settlement.ts';
import { failover } from '../../pipeline/stages.ts';
import { isForwardableUpstreamHeader } from '../../shared/upstream-response.ts';
import {
  stripSafetySettingsFromGemini,
  stripUnsupportedPartFieldsFromGemini,
  stripUnsupportedToolsFromGemini,
} from '../interceptors.ts';
import { messagesCountTokensWire, type TokenCountAnswer } from '../messages/count-tokens.ts';
import { chatTargetPicker } from '../shared/target-picker.ts';
import { materializeAttempt, resolveChatCandidates, type ChatNarrowing, type ChatServices } from '../stages.ts';
import { compose, defineStage, move, type Pipeline } from '@floway-dev/pipeline';
import { renderProtocolError } from '@floway-dev/protocols/common';
import type { GeminiPayload } from '@floway-dev/protocols/gemini';
import { translateGeminiViaMessages } from '@floway-dev/translate';

/** Counting is reachable only over an upstream's own Messages endpoint: no other protocol
 *  answers the question, and no translation invents an answer. */
export const geminiCountTokensTarget = chatTargetPicker(['messages']);

type Counted<K extends 'response.chat.gemini' | 'response.chat.messages'> = { [P in K]: TokenCountAnswer };

type G<K extends keyof GeminiFacts> = { [P in K]: GeminiFacts[P] };

/**
 * The outermost edge. A measurement is one object, so there is nothing to fold and nothing to
 * stream: what this decides is only whether the client is shown the count or the refusal that
 * stands in for it.
 */
const emitGeminiTokenCount = defineStage<
  Record<string, never>,
  Record<string, never>,
  Counted<'response.chat.gemini'> & G<'response.http.headers'>,
  G<'response.chat.gemini.rendered' | 'response.http.status' | 'response.http.headers'>,
  ChatServices
>({
  name: 'emitGeminiTokenCount',
  through: {
    request: { needs: [], consumes: [], provides: [] },
    response: {
      needs: ['response.chat.gemini', 'response.http.headers'],
      consumes: ['response.chat.gemini', 'response.http.headers'],
      provides: ['response.chat.gemini.rendered', 'response.http.status', 'response.http.headers'],
    },
  },
  execute: async (facts, next) => {
    const back = await next(facts);
    const { 'response.chat.gemini': answer, 'response.http.headers': headers, ...rest } = back;
    // Vendor traces and quota state stay visible; what an intermediary must strip, and what
    // would misdescribe a body this gateway serialized itself, does not. A filter that removed
    // nothing hands the same array on, so the record shows no change where none happened.
    const forwardable = headers.filter(([name]) => isForwardableUpstreamHeader(name));
    const forClient = forwardable.length === headers.length ? headers : move(forwardable);

    if (isFailure(answer)) {
      return {
        ...rest,
        'response.http.headers': forClient,
        'response.chat.gemini.rendered': move(renderProtocolError(answer.body, () => renderGeminiError(answer.status, answer.message))),
        'response.http.status': answer.status,
      };
    }
    return {
      ...rest,
      'response.http.headers': forClient,
      'response.chat.gemini.rendered': move(answer.body as Record<string, unknown>),
      'response.http.status': 200,
    };
  },
});

/**
 * Asks the question in Messages, and reads the answer back out as Google's.
 *
 * It consumes this protocol's request key and provides the target's, exactly as a handoff
 * does, so the wire below sees only Messages and cannot tell it was reached by translation.
 * What differs is the way back: there are no frames to map, only counts.
 */
const measureGeminiAsMessages = defineStage<
  G<'request.chat.gemini' | 'route.attempt'>,
  G<'request.chat.messages'>,
  Counted<'response.chat.messages'>,
  Counted<'response.chat.gemini'>,
  ChatServices
>({
  name: 'measureGeminiAsMessages',
  through: {
    request: {
      needs: ['request.chat.gemini', 'route.attempt'],
      consumes: ['request.chat.gemini'],
      provides: ['request.chat.messages'],
    },
    response: {
      needs: ['response.chat.messages'],
      consumes: ['response.chat.messages'],
      provides: ['response.chat.gemini'],
    },
  },
  execute: async (facts, next, use) => {
    const candidate = use.resolveAttempt(facts['route.attempt']);
    const trip = await translateGeminiViaMessages(facts['request.chat.gemini'], {
      model: candidate.model.id,
      fallbackMaxOutputTokens: candidate.model.limits.max_output_tokens,
    });
    // The translator writes a turn, and a turn says how its answer is delivered. There is no
    // answer to deliver here, so the field does not travel.
    const { stream: _stream, ...target } = trip.target;

    const { 'request.chat.gemini': _asked, ...down } = facts;
    const back = await next({ ...down, 'request.chat.messages': move(target) });
    const { 'response.chat.messages': counted, ...up } = back;
    return { ...up, 'response.chat.gemini': move(asGeminiTokenCount(counted)) };
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
const asGeminiTokenCount = (counted: TokenCountAnswer): TokenCountAnswer => {
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
const narrowing = (payload: GeminiPayload): ChatNarrowing<Counted<'response.chat.gemini'>> => ({
  canServe: candidate => geminiCountTokensTarget.canServe(candidate.model.endpoints),
  affinity: async gateway => await analyzeGeminiAffinity(payload, gateway.affinity.codec),
  unsupported: model => `Model ${model} does not support countTokens.`,
  refuse: (status, message) => ({ 'response.chat.gemini': { status, message } }),
  refuses: ['response.chat.gemini'],
});

export type GeminiCountTokensEntry = G<
  'ingress.http.headers' | 'ingress.chat.sourceProtocol' | 'request.chat.gemini' | 'serve.model'
>;

export type GeminiCountTokensExit = G<
  'response.chat.gemini.rendered' | 'response.http.status' | 'response.http.headers'
>;

export const geminiCountTokensPipeline = (payload: GeminiPayload): Pipeline<GeminiCountTokensEntry, GeminiCountTokensExit> =>
  compose('geminiCountTokens', [
    emitGeminiTokenCount,
    // A measurement goes through settlement like every other run. It provides an empty
    // billed set because nothing here is billable today, not because the operation is
    // exempt — an upstream that began charging for it would provide a non-empty one and
    // nothing else would change.
    writeSettlement(handedUp => isFailure((handedUp as { 'response.chat.gemini'?: unknown })['response.chat.gemini'])),
    resolveChatCandidates(narrowing(payload)),
    failover({
      failed: handedUp => isFailure((handedUp as { 'response.chat.gemini'?: unknown })['response.chat.gemini']),
      owns: [],
    }),
    materializeAttempt('request.chat.gemini'),
    stripUnsupportedPartFieldsFromGemini,
    stripUnsupportedToolsFromGemini,
    stripSafetySettingsFromGemini,
    measureGeminiAsMessages,
    ...messagesCountTokensWire,
  ]);
