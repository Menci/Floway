import { responsesInterceptors } from './interceptors/index.ts';
import type { ResponsesAttemptResult, ResponsesInvocation } from './interceptors/types.ts';
import { createStoredResponseId } from './items/format.ts';
import { normalizeAssistantInputText } from './items/normalize-assistant-content.ts';
import { drainAsync, syntheticEventsFromResult, wrapResponsesOutputForStorage } from './items/output.ts';
import { rewriteResponsesItemsForCandidate, type RewrittenResponsesPayload } from './items/rewrite.ts';
import type { StatefulResponsesStore } from './items/store.ts';
import { tokenUsageFromResponsesResult } from './usage.ts';
import { recordPerformanceLatency, requireRecordedDurationMs } from '../../shared/telemetry/performance.ts';
import { chatCompletionsAttempt } from '../chat-completions/attempt.ts';
import { messagesAttempt } from '../messages/attempt.ts';
import { providerStreamResultToExecuteResult, buildUpstreamCallOptions, telemetryModelIdentity, chatTargetPicker } from '../shared/attempt-helpers.ts';
import { tryCatchChatServeFailure } from '../shared/errors.ts';
import type { ChatGatewayCtx } from '../shared/gateway-ctx.ts';
import { traverseTranslation } from '../shared/translate-traverse.ts';
import { createUpstreamLatencyRecorder, recordUpstreamHttpFailure, upstreamPerformanceContext } from '../shared/upstream-telemetry.ts';
import { runInterceptors } from '@floway-dev/interceptor';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import { collectResponsesProtocolEventsToResult } from '@floway-dev/protocols/responses';
import { type ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import { type ModelCandidate, eventResult, readUpstreamApiError, providerModelOf, type ChatTargetApi, type ExecuteResult, type ProviderResponsesResult, type ResponsesAction } from '@floway-dev/provider';
import { translateResponsesViaChatCompletions, translateResponsesViaMessages } from '@floway-dev/translate';
import type { CanonicalResponsesPayload } from '@floway-dev/translate/via-responses/responses-items';

// `/v1/responses` generate prefers the native Responses target, then the
// translated Messages path, then the translated Chat Completions path. The
// same picker covers compact: every Responses target is reachable via the
// shim, which pivots compact→generate inside the chain on non-responses
// targets.
export const responsesTarget = chatTargetPicker(['responses', 'messages', 'chat-completions']);

export interface ResponsesAttemptInvokeArgs {
  readonly payload: CanonicalResponsesPayload;
  readonly action: ResponsesAction;
  readonly ctx: ChatGatewayCtx;
  readonly candidate: ModelCandidate;
  readonly headers: Headers;
}

// Single entry point for both `action: 'generate'` and `action: 'compact'`.
// Envelope-drain branches on the caller's intent (`action` passed by value),
// not on `invocation.action`. Interceptors are free to mutate `ctx.action`
// to steer inner dispatch — and, by the project's interceptor convention,
// they do not restore on the way out — so post-chain `invocation.action`
// reflects whatever the last writer left it at. The shape of the result we
// hand back is the caller's contract; keying off the caller's value is the
// only place that contract lives.
//
// The module-boundary invariant `compact-shaped ⇒ targetApi='responses'`
// at dispatch time is enforced in two places, each at the layer that owns
// the corresponding piece of state:
//
//   - `invocation.action === 'compact'` is caught inside `dispatchResponses`'s
//     `case 'messages'` / `case 'chat-completions'` arms — action is a
//     Responses-level metadata field that the translators never see.
//   - A `compaction_trigger` (or any other compact-shaped) item in input is
//     caught by the translator itself — the `responses-via-messages` and
//     `responses-via-chat-completions` translators reject any input-item
//     variant they do not handle, so a compaction_trigger that slipped past
//     the shim surfaces as a translator-level error rather than a silent
//     drop.
//
// Both safety nets fire pre-upstream-call, live inside the chain (not after
// the interceptor finally blocks), and stay independent of the shim's
// presence.
//
// Snapshot persistence is owned end-to-end by `wrapResponsesOutputForStorage`,
// which derives the snapshot mode by observing the output stream — `'replace'`
// when any output item is a compaction (the three convergence cases:
// native `/v1/responses/compact`, a `compaction_trigger` input on
// `/v1/responses` reshaped by the upstream, and the server-side
// `context_management` `compact_threshold` mode), `'append'` otherwise.
// "Don't write" is expressed by the store itself: cross-protocol translation
// stores (`createNonResponsesSourceStore`) and `store=false` HTTP turns ship
// with an empty `snapshotWrites` configuration, so `commitSnapshot` is a
// no-op at the store-write layer.
export const responsesAttempt = {
  invoke: async (args: ResponsesAttemptInvokeArgs): Promise<ResponsesAttemptResult> => {
    const { payload, action, ctx, candidate, headers } = args;
    const { store } = ctx;
    const targetApi = responsesTarget.pick(candidate.model.endpoints);
    // Rewrite + privatePayload seed + assistant-content normalization all run
    // BEFORE the interceptor chain so source interceptors — most importantly
    // the web-search server-tool shim — see fully inline-expanded input items
    // with their original wire ids, and `store.getPrivatePayload(id)` is
    // ready to hand back the persisted IR. The shim's `transformItems` runs
    // inside the chain body, before `run()`, so deferring rewrite/seed to
    // the inner closure would leave the shim looking at the pre-rewrite
    // wire shape against an empty privatePayload map.
    const rewritten = await rewriteOrRenderFailure(payload, store, candidate);
    if (!('payload' in rewritten)) return rewritten.failure;
    store.beginAttempt(rewritten.references);
    // Copilot compaction and Azure-native compaction both emit assistant
    // messages whose content blocks have `type: 'input_text'`, then refuse
    // the same items echoed back as input on the next turn. Normalising
    // here, after the rewrite has expanded any `item_reference` items
    // from the snapshot store, catches both the direct-echo and
    // store-replay paths in one place.
    const normalized: CanonicalResponsesPayload = { ...rewritten.payload, input: normalizeAssistantInputText(rewritten.payload.input) };

    const invocation: ResponsesInvocation = {
      payload: normalized,
      action,
      candidate,
      targetApi,
      headers,
    };
    const chainResult = await runInterceptors(invocation, ctx, responsesInterceptors, async () =>
      await dispatchResponses(invocation, ctx));

    if (chainResult.type !== 'events') return chainResult;

    const responseId = createStoredResponseId();
    if (action === 'compact') {
      // The caller entered through /v1/responses/compact (or serve.compact).
      // Drain the chain's events — whether they came from a native /compact
      // wire or from the responses-compact-shim's synthesized envelope —
      // into a single result envelope so the http layer can JSON-encode it
      // directly. Storage still runs over the synthesized event stream so
      // the snapshot is committed under the same id the client will see —
      // wrap detects the `compaction` output item and writes a `'replace'`
      // snapshot.
      const upstreamCompacted = await collectResponsesProtocolEventsToResult(chainResult.events);
      await drainAsync(wrapResponsesOutputForStorage(syntheticEventsFromResult(upstreamCompacted), {
        store,
        upstream: candidate.provider.upstream,
        targetApi: 'responses',
        responseId,
      }));
      return {
        type: 'result',
        result: { ...upstreamCompacted, id: responseId },
        modelIdentity: chainResult.modelIdentity,
        usage: tokenUsageFromResponsesResult(upstreamCompacted),
      };
    }

    // Persistence and id rewriting wrap the *outermost* stream — after every
    // interceptor (including the server-tool shim) has emitted its final
    // events. This is the only seam at which the gateway-owned response id
    // is minted; whatever id any inner layer produced (the upstream's blob,
    // the shim's internal `resp_shim_*` placeholder) is overwritten to a
    // `resp_<crc>_<body>` before the client sees a frame, and the snapshot
    // is committed under the same id so the next turn's
    // `previous_response_id` lookup is guaranteed to hit.
    return eventResult(
      wrapResponsesOutputForStorage(chainResult.events, {
        store,
        upstream: candidate.provider.upstream,
        targetApi,
        responseId,
      }),
      chainResult.modelIdentity,
      {
        performance: chainResult.performance,
        finalMetadata: chainResult.finalMetadata,
        headers: chainResult.headers,
      },
    );
  },

  // Narrowing wrapper for cross-protocol translation callers
  // (Messages/Gemini/ChatCompletions translating into Responses) and the
  // native HTTP/WS generate entry — both always run in generate mode and
  // want the ExecuteResult branch. The compact branch is a contract
  // violation here; an interceptor that pivoted generate→compact would
  // surface as a throw, not a silent shape mismatch.
  generate: async (args: Omit<ResponsesAttemptInvokeArgs, 'action'>): Promise<ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>> => {
    const result = await responsesAttempt.invoke({ ...args, action: 'generate' });
    if (result.type === 'result') {
      throw new Error('responsesAttempt.generate received a compact result; an interceptor pivoted generate→compact unexpectedly');
    }
    return result;
  },
};

type RewriteOutcome =
  | RewrittenResponsesPayload
  | { readonly failure: ExecuteResult<ProtocolFrame<ResponsesStreamEvent>> };

const rewriteOrRenderFailure = async (
  payload: CanonicalResponsesPayload,
  store: StatefulResponsesStore,
  candidate: ModelCandidate,
): Promise<RewriteOutcome> => {
  try {
    return await rewriteResponsesItemsForCandidate(payload, store, candidate);
  } catch (error) {
    const failure = tryCatchChatServeFailure(error);
    if (failure === null) throw error;
    // The full Responses failure renderer that also handles `model-missing`
    // / `model-unsupported` / `routing-unavailable` lives in the serve
    // layer and treats the `endpoint` distinction (`generate` vs
    // `compact`); from inside an attempt, only `item-not-found` is
    // reachable from rewrite — anything else is a bug. Re-throw the
    // original error so the upstream stack/cause survives.
    if (failure.kind !== 'item-not-found') throw error;
    return {
      failure: {
        type: 'api-error',
        source: 'gateway',
        status: 404,
        headers: new Headers({ 'content-type': 'application/json' }),
        body: new TextEncoder().encode(JSON.stringify({
          error: {
            message: `Item with id '${failure.itemId}' not found.`,
            type: 'invalid_request_error',
            param: 'input',
            code: null,
          },
        })),
      },
    };
  }
};

const dispatchResponses = async (
  invocation: ResponsesInvocation,
  ctx: ChatGatewayCtx,
): Promise<ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>> => {
  const { candidate, targetApi } = invocation;
  switch (targetApi) {
  case 'responses': {
    const recorder = createUpstreamLatencyRecorder();
    if (invocation.action === 'compact') {
      // The compact wire body drops `stream` and `store` — `store` is a
      // gateway-only snapshot-persistence hint that the upstream compact
      // endpoint rejects, and `stream` is irrelevant on a non-streaming
      // call. The generate branch leaves both fields on the body so the
      // provider can decide for itself (every provider's streaming call
      // forces stream=true anyway).
      const { model: _model, stream: _stream, store: _store, ...body } = invocation.payload;
      const providerResult = await candidate.provider.instance.callResponses(
        providerModelOf(candidate),
        body,
        invocation.action,
        ctx.abortSignal,
        buildUpstreamCallOptions(candidate, ctx, recorder.record, invocation.headers),
      );
      return await providerResponsesResultToExecuteResult(providerResult, candidate, targetApi, ctx, recorder);
    }
    const { model: _model, ...body } = invocation.payload;
    const providerResult = await candidate.provider.instance.callResponses(
      providerModelOf(candidate),
      body,
      invocation.action,
      ctx.abortSignal,
      buildUpstreamCallOptions(candidate, ctx, recorder.record, invocation.headers),
    );
    return await providerResponsesResultToExecuteResult(providerResult, candidate, targetApi, ctx, recorder);
  }
  case 'messages':
    if (invocation.action === 'compact') {
      // The responses-compact-shim is structurally required on non-responses
      // targets and pivots ctx.action to 'generate' before reaching here;
      // landing inside this case with action='compact' means the shim
      // disengaged or was wired out of the chain. A compaction_trigger in
      // input is caught one layer down by the translator's
      // unexpected-input-item guard.
      throw new Error(`responsesAttempt: action='compact' reached dispatch on targetApi='messages' — the responses-compact-shim must engage and pivot the action`);
    }
    return await traverseTranslation(
      invocation.payload,
      p => translateResponsesViaMessages(p, {
        model: candidate.model.id,
        fallbackMaxOutputTokens: candidate.model.limits.max_output_tokens,
      }),
      translated => messagesAttempt.generate({
        payload: translated, ctx, candidate, headers: invocation.headers,
      }),
    );
  case 'chat-completions':
    if (invocation.action === 'compact') {
      throw new Error(`responsesAttempt: action='compact' reached dispatch on targetApi='chat-completions' — the responses-compact-shim must engage and pivot the action`);
    }
    return await traverseTranslation(
      invocation.payload,
      p => translateResponsesViaChatCompletions(p, { model: candidate.model.id }),
      translated => chatCompletionsAttempt.generate({
        payload: translated, ctx, candidate, headers: invocation.headers,
      }),
    );
  default: {
    const exhaustive: never = targetApi;
    throw new Error(`unexpected targetApi '${exhaustive as string}'`);
  }
  }
};

// Lowers a `ProviderResponsesResult` into the chain's
// ExecuteResult<ProtocolFrame<ResponsesStreamEvent>> currency. The compact
// branch synthesizes SSE frames from the envelope so every downstream
// interceptor sees the same event-stream contract regardless of which action
// the provider executed.
const providerResponsesResultToExecuteResult = async (
  providerResult: ProviderResponsesResult,
  candidate: ModelCandidate,
  targetApi: ChatTargetApi,
  ctx: ChatGatewayCtx,
  recorder: ReturnType<typeof createUpstreamLatencyRecorder>,
): Promise<ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>> => {
  if (providerResult.action === 'generate') {
    return await providerStreamResultToExecuteResult(
      providerResult.ok
        ? { ok: true, events: providerResult.events, modelKey: providerResult.modelKey, ...(providerResult.headers ? { headers: providerResult.headers } : {}) }
        : { ok: false, response: providerResult.response, modelKey: providerResult.modelKey },
      candidate,
      targetApi,
      ctx,
      recorder,
    );
  }
  // action === 'compact'. The non-streaming envelope expands into the same
  // event stream wrap-output-storage consumes for the streaming path.
  const context = upstreamPerformanceContext(ctx, candidate, providerResult.modelKey);
  if (!providerResult.ok) {
    recordUpstreamHttpFailure(ctx, context);
    return { ...(await readUpstreamApiError(providerResult.response, candidate.provider.upstream)), performance: context };
  }
  ctx.backgroundScheduler(recordPerformanceLatency(context, 'upstream_success', requireRecordedDurationMs(recorder, 'callResponses(action=compact)')));
  return eventResult(
    syntheticEventsFromResult(providerResult.result),
    telemetryModelIdentity(candidate, providerResult.modelKey),
    { performance: context },
  );
};
