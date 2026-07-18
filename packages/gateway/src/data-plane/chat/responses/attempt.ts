import { responsesInterceptors } from './interceptors/index.ts';
import type { ResponsesAttemptResult, ResponsesInvocation } from './interceptors/types.ts';
import { normalizeAssistantInputText } from './items/normalize-assistant-content.ts';
import { syntheticEventsFromResult } from './items/output.ts';
import { tokenUsageFromResponsesResult } from './usage.ts';
import { applyRulesToUpstreamResponses } from '../../model-aliases/apply-rules.ts';
import { providerStreamResultToExecuteResult, buildUpstreamCallOptions, telemetryModelIdentity, chatTargetPicker, upstreamPerformanceContext } from '../../shared/telemetry/attempt-helpers.ts';
import { chatCompletionsAttempt } from '../chat-completions/attempt.ts';
import { messagesAttempt } from '../messages/attempt.ts';
import { createExternalImageLoader } from '../shared/external-image-loader.ts';
import type { ChatGatewayCtx } from '../shared/gateway-ctx.ts';
import { traverseTranslation } from '../shared/translate-traverse.ts';
import { runInterceptors } from '@floway-dev/interceptor';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import { collectResponsesProtocolEventsToResult, type CanonicalResponsesPayload, type ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import { type ModelCandidate, eventResult, readUpstreamApiError, providerModelOf, type ChatTargetApi, type ExecuteResult, type ProviderResponsesResult, type ResponsesAction } from '@floway-dev/provider';
import { translateResponsesViaChatCompletions, translateResponsesViaMessages } from '@floway-dev/translate';

// `/v1/responses` generate prefers the native Responses target, then the
// translated Messages path, then the translated Chat Completions path. The
// same picker covers compact: every Responses target is reachable via the
// shim, which pivots compact→generate inside the chain on non-responses
// targets.
export const responsesTarget = chatTargetPicker(['responses', 'messages', 'chat-completions']);

interface ResponsesAttemptBaseArgs {
  readonly action: ResponsesAction;
  readonly payload: CanonicalResponsesPayload;
  readonly ctx: ChatGatewayCtx;
  readonly candidate: ModelCandidate;
  readonly headers: Headers;
}

interface ResponsesSourceState {
  readonly privatePayloads: ReadonlyMap<string, unknown>;
}

export type ResponsesAttemptInvokeArgs = ResponsesAttemptBaseArgs & {
  readonly sourceState?: ResponsesSourceState;
};
type ResponsesAttemptGenerateArgs = Omit<ResponsesAttemptInvokeArgs, 'action'>;

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
// Responses state and client affinity both belong to the native source edge,
// outside this candidate attempt. Native serve passes the already-restored
// candidate payload plus any private source state; translated inner Responses
// calls pass only their translated payload. Keeping this function free of
// affinity decoding, state hydration, public-id minting, and persistence
// prevents an inner Responses target from owning another source protocol's
// client-visible state.
export const responsesAttempt = {
  invoke: async (args: ResponsesAttemptInvokeArgs): Promise<ResponsesAttemptResult> => {
    const { action, ctx, candidate, headers: sourceHeaders } = args;
    const headers = new Headers(sourceHeaders);
    const targetApi = responsesTarget.pick(candidate.model.endpoints);
    const payload = { ...structuredClone(args.payload), model: candidate.model.id };
    if (args.sourceState === undefined) {
      ctx.store.beginAttempt(new Map());
    } else {
      ctx.store.beginAttempt(args.sourceState.privatePayloads, {
        upstreamId: candidate.provider.upstream,
        restoresItemIds: targetApi === 'responses',
      });
    }
    // Copilot compaction and Azure-native compaction both emit assistant
    // messages whose content blocks have `type: 'input_text'`, then refuse
    // the same items echoed back as input on the next turn. Normalising
    // here, after native serve has expanded stored `item_reference` items,
    // catches both the direct-echo and store-replay paths in one place.
    const normalized: CanonicalResponsesPayload = { ...payload, input: normalizeAssistantInputText(payload.input) };

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

    if (action === 'compact') {
      const upstreamCompacted = await collectResponsesProtocolEventsToResult(chainResult.events);
      return {
        type: 'result',
        result: upstreamCompacted,
        modelIdentity: chainResult.modelIdentity,
        usage: tokenUsageFromResponsesResult(upstreamCompacted),
        performance: chainResult.performance,
      };
    }
    return chainResult;
  },

  // Narrowing wrapper for cross-protocol translation callers
  // (Messages/Gemini/ChatCompletions translating into Responses) and the
  // native HTTP/WS generate entry — both always run in generate mode and
  // want the ExecuteResult branch. The compact branch is a contract
  // violation here; an interceptor that pivoted generate→compact would
  // surface as a throw, not a silent shape mismatch.
  generate: async (args: ResponsesAttemptGenerateArgs): Promise<ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>> => {
    const result = await responsesAttempt.invoke({ ...args, action: 'generate' });
    if (result.type === 'result') {
      throw new Error('responsesAttempt.generate received a compact result; an interceptor pivoted generate→compact unexpectedly');
    }
    return result;
  },
};

const dispatchResponses = async (
  invocation: ResponsesInvocation,
  ctx: ChatGatewayCtx,
): Promise<ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>> => {
  const { candidate, targetApi } = invocation;
  switch (targetApi) {
  case 'responses': {
    if (candidate.rules !== undefined) applyRulesToUpstreamResponses(invocation.payload, candidate.rules);
    // Compact drops `stream` and `store` before hitting the wire: `store` is a
    // gateway-only snapshot-persistence hint the upstream compact endpoint
    // rejects, and `stream` is irrelevant on a non-streaming call. The generate
    // branch leaves both fields on the body — every provider's streaming call
    // forces stream=true anyway.
    let body: Omit<CanonicalResponsesPayload, 'model'>;
    if (invocation.action === 'compact') {
      const { model: _model, stream: _stream, store: _store, ...rest } = invocation.payload;
      body = rest;
    } else {
      const { model: _model, ...rest } = invocation.payload;
      body = rest;
    }
    const providerResult = await candidate.provider.instance.callResponses(
      providerModelOf(candidate),
      body,
      invocation.action,
      ctx.abortSignal,
      buildUpstreamCallOptions(candidate, ctx, invocation.headers),
    );
    return await providerResponsesResultToExecuteResult(providerResult, candidate, targetApi, ctx);
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
        loadRemoteImage: createExternalImageLoader(ctx.abortSignal),
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
): Promise<ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>> => {
  if (providerResult.action === 'generate') {
    return await providerStreamResultToExecuteResult(
      providerResult.ok
        ? { ok: true, events: providerResult.events, modelKey: providerResult.modelKey, ...(providerResult.headers ? { headers: providerResult.headers } : {}) }
        : { ok: false, response: providerResult.response, modelKey: providerResult.modelKey },
      candidate,
      targetApi,
      ctx,
    );
  }
  const context = upstreamPerformanceContext(ctx, candidate, 'chat');
  if (!providerResult.ok) {
    return { ...(await readUpstreamApiError(providerResult.response, candidate.provider.upstream)), performance: context };
  }
  return eventResult(
    syntheticEventsFromResult(providerResult.result),
    telemetryModelIdentity(candidate, providerResult.modelKey),
    { performance: context },
  );
};
