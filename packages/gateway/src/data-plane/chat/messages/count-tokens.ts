// `/v1/messages/count_tokens` as a pipeline.
//
//   emitMessagesTokenCount  the edge: writes the measurement, or the refusal, as one body
//   resolveChatCandidates   narrows to what can serve, in the order affinity asks for
//   failover                runs what follows once per candidate
//   materializeAttempt      puts the payload this candidate is owed into the record
//   the three request rules generation applies, and the web-search request preparation
//   callMessagesCountTokensUpstream  the ending: measures, and never opens a stream
//
// A second **operation** over this protocol rather than another wire under
// `messagesServePipeline`, which is why it is a chain of its own rather than a branch inside
// that one. It answers with a body and nothing else: no stream, and no billed turn — the
// replaced surface wrote neither a usage row nor a performance sample for a measurement, so
// there is no `writeSettlement` here and the ending states an empty billed set.
//
// There is one wire, and it is shared. Only an upstream's own Messages endpoint measures —
// no protocol but this one answers "what would this cost" — so the chain dials directly
// instead of forking, and Gemini's `:countTokens` translates into the same wire rather than
// growing one of its own. The rule generation keeps inside its Messages wire (the system-role
// rewrite, which speaks about what that endpoint accepts) is therefore a rule of this wire
// too, and sits with it.
//
// What it measures is what generation would send. The same three request rules run, in the
// order the interceptor chain ran them, and the web-search shim's request half runs above
// them: a client that asked for the native server tool is measured on the client-tool shape
// the gateway would actually put on the wire.

import { analyzeMessagesAffinity } from './affinity/ingress.ts';
import { renderMessagesError } from './errors.ts';
import { prepareMessagesWebSearchShimRequest } from './interceptors/web-search-shim.ts';
import type { MessagesFacts } from './pipeline.ts';
import { bodyForAttempt } from '../../pipeline/attempt-body.ts';
import type { Failure } from '../../pipeline/facts.ts';
import { isFailure } from '../../pipeline/facts.ts';
import { writeSettlement } from '../../pipeline/settlement.ts';
import { failover } from '../../pipeline/stages.ts';
import { buildUpstreamCallOptions } from '../../shared/upstream-call-options.ts';
import { isForwardableUpstreamHeader } from '../../shared/upstream-response.ts';
import {
  applyRoleCompatibilityToMessages,
  disableReasoningOnForcedToolChoiceForMessages,
  stripBillingAttributionFromMessages,
} from '../interceptors.ts';
import { applyRulesToUpstreamMessages } from '../shared/alias-rules.ts';
import { chatTargetPicker } from '../shared/target-picker.ts';
import { materializeAttempt, resolveChatCandidates, type ChatNarrowing, type ChatServices } from '../stages.ts';
import { compose, defineStage, move, type Pipeline, type Stage } from '@floway-dev/pipeline';
import { renderProtocolError } from '@floway-dev/protocols/common';
import { parseAnthropicBetaHeader, type MessagesPayload } from '@floway-dev/protocols/messages';
import { providerModelOf } from '@floway-dev/provider';

/** Counting has no translation path: only an upstream's own Messages endpoint can answer the
 *  question, so a candidate that would serve generation over a translated wire cannot serve
 *  this. */
export const messagesCountTokensTarget = chatTargetPicker(['messages']);

/** What a measurement hands up. It rides at a protocol's own response key — which is what
 *  lets the request rules generation runs be the same stages here — and the arm is narrowed
 *  because nothing in a counting chain opens a stream. */
export type TokenCountAnswer = { readonly kind: 'value'; readonly body: unknown } | Failure;

type Counted<K extends 'response.chat.messages'> = { [P in K]: TokenCountAnswer };

type M<K extends keyof MessagesFacts> = { [P in K]: MessagesFacts[P] };

/**
 * The outermost edge. A measurement is one object, so there is nothing to fold and nothing
 * to stream: what this decides is only whether the client is shown the upstream's counts or
 * the refusal that stands in for them.
 */
const emitMessagesTokenCount = defineStage<
  Record<string, never>,
  Record<string, never>,
  Counted<'response.chat.messages'> & M<'response.http.headers'>,
  M<'response.chat.messages.rendered' | 'response.http.status' | 'response.http.headers'>,
  ChatServices
>({
  name: 'emitMessagesTokenCount',
  through: {
    request: { needs: [], consumes: [], provides: [] },
    response: {
      needs: ['response.chat.messages', 'response.http.headers'],
      consumes: ['response.chat.messages', 'response.http.headers'],
      provides: ['response.chat.messages.rendered', 'response.http.status', 'response.http.headers'],
    },
  },
  execute: async (facts, next) => {
    const back = await next(facts);
    const { 'response.chat.messages': answer, 'response.http.headers': headers, ...rest } = back;
    // Vendor traces and quota state stay visible; what an intermediary must strip, and what
    // would misdescribe a body this gateway serialized itself, does not. A filter that removed
    // nothing hands the same array on, so the record shows no change where none happened.
    const forwardable = headers.filter(([name]) => isForwardableUpstreamHeader(name));
    const forClient = forwardable.length === headers.length ? headers : move(forwardable);

    if (isFailure(answer)) {
      return {
        ...rest,
        'response.http.headers': forClient,
        'response.chat.messages.rendered': move(renderProtocolError(answer.body, () => renderMessagesError(answer.status, answer.message))),
        'response.http.status': answer.status,
      };
    }
    return {
      ...rest,
      'response.http.headers': forClient,
      'response.chat.messages.rendered': move(answer.body as Record<string, unknown>),
      'response.http.status': 200,
    };
  },
});

/**
 * Puts the request into the shape the web-search shim would actually send.
 *
 * Anthropic's native `web_search_*` server tool becomes an ordinary client tool on the wire,
 * and prior turns' results are rewritten back into the history the upstream issued them
 * with — so a count taken on the client's own body would measure a request no upstream is
 * ever sent. Only the rewrite runs here: there is no stream to intercept and no search to
 * execute, because nothing is generated.
 *
 * `messages-web-search-shim` is the whole of the gate, where generation also engages the
 * shim unconditionally on a translated wire: counting has only the native wire, so the
 * structural half of that condition can never hold.
 *
 * A tool definition this protocol rejects is an answer it already holds, which is why it
 * carries the `return` trait.
 */
const prepareMessagesWebSearchRequest = defineStage<
  M<'request.chat.messages' | 'route.attempt'>,
  M<'request.chat.messages'>,
  Counted<'response.chat.messages'>,
  Counted<'response.chat.messages'>,
  Counted<'response.chat.messages'> & M<'response.usage.billable' | 'response.http.headers'>,
  ChatServices
>({
  name: 'prepareMessagesWebSearchRequest',
  through: {
    request: {
      needs: ['request.chat.messages', 'route.attempt'],
      consumes: [],
      provides: ['request.chat.messages'],
    },
    response: { needs: ['response.chat.messages'], consumes: [], provides: [] },
  },
  return: { provides: ['response.chat.messages', 'response.usage.billable', 'response.http.headers'] },
  execute: async (facts, next) => {
    if (!facts['route.attempt'].flags.includes('messages-web-search-shim')) return await next(facts);
    const prepared = prepareMessagesWebSearchShimRequest(facts['request.chat.messages']);
    if (prepared.type === 'invalid-request') {
      // Nothing was dialled, which is what an empty billed set and an empty header list say
      // on the other two keys.
      return move({
        ...facts,
        'response.chat.messages': { status: 400, message: prepared.message },
        'response.usage.billable': [],
        'response.http.headers': [],
      });
    }
    // A request that engaged nothing comes back by identity, so the record shows no change
    // where none happened.
    if (prepared.payload === facts['request.chat.messages']) return await next(facts);
    return await next({ ...facts, 'request.chat.messages': move(prepared.payload) });
  },
});

/**
 * The ending. It asks the upstream what the turn would cost and hands the answer up as a
 * value — the one shape this operation ever produces, because a measurement is a body and
 * never a stream.
 */
const callMessagesCountTokensUpstream = defineStage<
  M<'request.chat.messages' | 'route.attempt' | 'ingress.http.headers' | 'ingress.chat.sourceProtocol'>,
  Counted<'response.chat.messages'> & M<'response.usage.billable' | 'response.http.headers'>,
  ChatServices
>({
  name: 'callMessagesCountTokensUpstream',
  return: {
    provides: ['response.chat.messages', 'response.usage.billable', 'response.http.headers'],
  },
  execute: async (facts, use) => {
    const candidate = use.resolveAttempt(facts['route.attempt']);

    // The payload affinity materialized for this candidate, as every stage between the fork
    // and here has rewritten it — built for the dial exactly as generation builds it, so what
    // is measured is what generation would be charged for.
    const body = bodyForAttempt(facts['request.chat.messages'], candidate, applyRulesToUpstreamMessages);

    // Anthropic's beta flags have a typed path of their own, so no header allowlist can admit
    // them, and they are the client's own only when the client spoke this protocol.
    const headers = new Headers(facts['ingress.http.headers'].map(([name, value]): [string, string] => [name, value]));
    const anthropicBeta = facts['ingress.chat.sourceProtocol'] === 'messages'
      ? parseAnthropicBetaHeader(headers.get('anthropic-beta'))
      : [];
    headers.delete('anthropic-beta');

    // Nothing here is billed: measuring is not generating, and an upstream that answered
    // the question charged nothing for it.
    const nothingBilled = { 'response.usage.billable': [] as const };

    let response: Response;
    try {
      ({ response } = await candidate.provider.instance.callMessagesCountTokens(
        providerModelOf(candidate),
        body,
        use.gateway.abortSignal,
        { ...buildUpstreamCallOptions(candidate, use.gateway, headers), anthropicBeta },
      ));
    } catch (error) {
      use.log.warn('dial failed', { upstream: facts['route.attempt'].upstreamId, error: String(error) });
      // A dial that never completed reached no upstream, so there are no headers to carry.
      return move({
        ...facts,
        ...nothingBilled,
        'response.chat.messages': { status: 502, message: error instanceof Error ? error.message : String(error) },
        'response.http.headers': [],
      });
    }

    const text = await response.text();
    let parsed: unknown;
    try { parsed = JSON.parse(text) as unknown; } catch { parsed = undefined; }

    if (!response.ok) {
      use.log.warn('upstream refused', { status: response.status });
      return move({
        ...facts,
        ...nothingBilled,
        'response.chat.messages': {
          status: response.status,
          message: text,
          ...(parsed === undefined ? {} : { body: parsed }),
        },
        'response.http.headers': [...response.headers],
      });
    }

    return move({
      ...facts,
      ...nothingBilled,
      'response.chat.messages': { kind: 'value' as const, body: parsed },
      'response.http.headers': [...response.headers],
    });
  },
});

/**
 * The Messages count-tokens wire, as the chain that dials it.
 *
 * Every source protocol whose measurement reaches an upstream does it over this endpoint —
 * Gemini's `:countTokens` has no wire of its own and arrives here through a translation — so
 * a rule that speaks about *this* wire belongs here rather than beside a source's own
 * strippers. All four do: the system-role rewrite and the reasoning sentinel state what an
 * upstream's Messages endpoint accepts, the billing-attribution scrub states what generation
 * would have sent it, and the web-search preparation states the tool shape it would have
 * seen.
 */
export const messagesCountTokensWire: readonly Stage[] = [
  prepareMessagesWebSearchRequest,
  stripBillingAttributionFromMessages,
  disableReasoningOnForcedToolChoiceForMessages,
  applyRoleCompatibilityToMessages,
  callMessagesCountTokensUpstream,
];

/** A candidate that cannot serve *this* request is not a candidate — and what the client's
 *  own turn carries decides the order the rest are tried in, which is why the narrowing is
 *  built from the request rather than being a constant. */
const narrowing = (payload: MessagesPayload): ChatNarrowing<Counted<'response.chat.messages'>> => ({
  canServe: candidate => messagesCountTokensTarget.canServe(candidate.model.endpoints),
  affinity: async gateway => await analyzeMessagesAffinity(payload, gateway.affinity.codec),
  unsupported: model => `Model ${model} does not support the /messages/count_tokens endpoint.`,
  refuse: (status, message) => ({ 'response.chat.messages': { status, message } }),
  refuses: ['response.chat.messages'],
});

export type MessagesCountTokensEntry = M<
  'ingress.http.headers' | 'ingress.chat.sourceProtocol' | 'request.chat.messages' | 'serve.model'
>;

export type MessagesCountTokensExit = M<
  'response.chat.messages.rendered' | 'response.http.status' | 'response.http.headers'
>;

export const messagesCountTokensPipeline = (payload: MessagesPayload): Pipeline<MessagesCountTokensEntry, MessagesCountTokensExit> =>
  compose('messagesCountTokens', [
    emitMessagesTokenCount,
    // A measurement goes through settlement like every other run. It provides an empty
    // billed set because nothing here is billable today, not because the operation is
    // exempt — an upstream that began charging for it would provide a non-empty one and
    // nothing else would change.
    writeSettlement(handedUp => isFailure((handedUp as { 'response.chat.messages'?: unknown })['response.chat.messages'])),
    resolveChatCandidates(narrowing(payload)),
    failover({
      failed: handedUp => isFailure((handedUp as { 'response.chat.messages'?: unknown })['response.chat.messages']),
      owns: [],
    }),
    materializeAttempt('request.chat.messages'),
    ...messagesCountTokensWire,
  ]);
