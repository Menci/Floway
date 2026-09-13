import { klona } from 'klona/json';

import { openaiResponsesInterceptors } from './interceptors/index.ts';
import type { OpenAIResponsesAttemptResult, OpenAIResponsesInvocation } from './interceptors/types.ts';
import { normalizeAssistantInputText } from './items/normalize-assistant-content.ts';
import { syntheticEventsFromCompaction } from './items/output.ts';
import { openAIResponsesTransportOutput } from './transport-output.ts';
import { billableUsageFromOpenAIResponsesEvent, billableUsageFromOpenAIResponsesResult } from './usage.ts';
import { telemetryModelIdentity, upstreamPerformanceContext } from '../../shared/telemetry/attribution.ts';
import { tokenUsageFromBillableUsage } from '../../shared/telemetry/usage.ts';
import { buildUpstreamCallOptions } from '../../shared/upstream-call-options.ts';
import { anthropicMessagesAttempt } from '../anthropic-messages/attempt.ts';
import { openaiChatCompletionsAttempt } from '../openai-chat-completions/attempt.ts';
import { applyRulesToUpstreamOpenAIResponses } from '../shared/alias-rules.ts';
import { createExternalImageLoader } from '../shared/external-image-loader.ts';
import type { ChatGatewayCtx } from '../shared/gateway-ctx.ts';
import { providerStreamResultToExecuteResult } from '../shared/provider-stream-result.ts';
import { chatTargetPicker } from '../shared/target-picker.ts';
import { traverseTranslation } from '../shared/translate-traverse.ts';
import { runInterceptors } from '@floway-dev/interceptor';
import type { OpenAIResponsesTransport, ProtocolFrame } from '@floway-dev/protocols/common';
import { collectOpenAIResponsesProtocolEventsToResult, convertOpenAIResponsesTransport, OpenAIResponsesLiteInputError, OPENAI_RESPONSES_LITE_HEADER, openAIResponsesTransportForEndpoint, openAIResponsesTransportForRequest, type CanonicalOpenAIResponsesPayload, type OpenAIResponsesStreamEvent } from '@floway-dev/protocols/openai-responses';
import { type ModelCandidate, eventResult, readUpstreamApiError, providerModelOf, type ChatTargetApi, type ExecuteResult, type ProviderOpenAIResponsesResult, type OpenAIResponsesAction } from '@floway-dev/provider';
import { translateOpenAIResponsesViaOpenAIChatCompletions, translateOpenAIResponsesViaAnthropicMessages, TranslatorInputError } from '@floway-dev/translate';

// `/v1/responses` generate prefers the native OpenAI Responses target, then the
// translated Anthropic Messages path, then the translated OpenAI Chat Completions path. The
// same picker covers compact: every OpenAI Responses target is reachable via the
// shim, which pivots compact→generate inside the chain on non-openai-responses
// targets.
export const openaiResponsesTarget = chatTargetPicker(['openaiResponses', 'anthropicMessages', 'openaiChatCompletions']);

interface OpenAIResponsesAttemptBaseArgs {
  readonly action: OpenAIResponsesAction;
  readonly payload: CanonicalOpenAIResponsesPayload;
  readonly ctx: ChatGatewayCtx;
  readonly candidate: ModelCandidate;
  readonly headers: Headers;
}

interface OpenAIResponsesSourceState {
  readonly privatePayloads: ReadonlyMap<string, unknown>;
}

export type OpenAIResponsesAttemptInvokeArgs = OpenAIResponsesAttemptBaseArgs & {
  readonly sourceState?: OpenAIResponsesSourceState;
};
type OpenAIResponsesAttemptGenerateArgs = Omit<OpenAIResponsesAttemptInvokeArgs, 'action'>;

const withTransportInputErrors = <T>(run: () => T): T => {
  try {
    return run();
  } catch (error) {
    if (error instanceof OpenAIResponsesLiteInputError) {
      const inputError = new TranslatorInputError(error.message, { param: error.param, code: 'invalid_value' });
      inputError.cause = error;
      throw inputError;
    }
    throw error;
  }
};

// Single entry point for both `action: 'generate'` and `action: 'compact'`.
// Envelope-drain branches on the caller's intent (`action` passed by value),
// not on `invocation.action`. Interceptors are free to mutate `ctx.action`
// to steer inner dispatch — and, by the project's interceptor convention,
// they do not restore on the way out — so post-chain `invocation.action`
// reflects whatever the last writer left it at. The shape of the result we
// hand back is the caller's contract; keying off the caller's value is the
// only place that contract lives.
//
// The module-boundary invariant `compact-shaped ⇒ targetApi='openaiResponses'`
// at dispatch time is enforced in two places, each at the layer that owns
// the corresponding piece of state:
//
//   - `invocation.action === 'compact'` is caught inside `dispatchOpenAIResponses`'s
//     `case 'messages'` / `case 'openai-chat-completions'` arms — action is a
//     OpenAI-Responses-level metadata field that the translators never see.
//   - A `compaction_trigger` (or any other compact-shaped) item in input is
//     caught by the translator itself — the `openai-responses-via-anthropic-messages` and
//     `openai-responses-via-openai-chat-completions` translators reject any input-item
//     variant they do not handle, so a compaction_trigger that slipped past
//     the shim surfaces as a translator-level error rather than a silent
//     drop.
//
// Both safety nets fire pre-upstream-call, live inside the chain (not after
// the interceptor finally blocks), and stay independent of the shim's
// presence.
//
// OpenAI Responses state and client affinity both belong to the native source edge,
// outside this candidate attempt. Native serve passes the already-hydrated
// candidate payload plus any private source state; translated inner OpenAI Responses
// calls pass only their translated payload. Keeping this function free of
// affinity decoding, state hydration, and persistence
// prevents an inner OpenAI Responses target from owning another source protocol's
// client-visible state.
export const openaiResponsesAttempt = {
  invoke: async (args: OpenAIResponsesAttemptInvokeArgs): Promise<OpenAIResponsesAttemptResult> => {
    const { action, ctx, candidate, headers: sourceHeaders } = args;
    const headers = new Headers(sourceHeaders);
    const targetApi = openaiResponsesTarget.pick(candidate.model.endpoints);
    const sourceTransport = withTransportInputErrors(() => openAIResponsesTransportForRequest(args.payload, headers));
    const chainTransport = sourceTransport === 'lite' && targetApi === 'openaiResponses'
      && openAIResponsesTransportForEndpoint(candidate.model.endpoints.openaiResponses) === 'lite'
      ? 'lite'
      : 'standard';
    headers.delete(OPENAI_RESPONSES_LITE_HEADER);
    const payload = {
      // Standard requests retain top-level tools until after the server-tool
      // shim. Native Lite requests keep their ordered input and client ids;
      // round-tripping through standard would replace the prompt prefix.
      // https://github.com/openai/codex/blob/315195492c80fdade38e917c18f9584efd599304/codex-rs/core/src/client.rs#L1113-L1153
      ...withTransportInputErrors(() => convertOpenAIResponsesTransport(klona(args.payload), sourceTransport, chainTransport)),
      model: candidate.model.id,
    };
    ctx.store.beginAttempt(args.sourceState?.privatePayloads ?? new Map());
    // Copilot compaction and Azure-native compaction both emit assistant
    // messages whose content blocks have `type: 'input_text'`, then refuse
    // the same items echoed back as input on the next turn. Normalising
    // here, after native serve has expanded stored `item_reference` items,
    // catches both the direct-echo and store-replay paths in one place.
    const normalized: CanonicalOpenAIResponsesPayload = { ...payload, input: normalizeAssistantInputText(payload.input) };

    const invocation: OpenAIResponsesInvocation = {
      payload: normalized,
      action,
      candidate,
      targetApi,
      headers,
    };
    const upstreamResult = await runInterceptors(invocation, ctx, openaiResponsesInterceptors, async () =>
      await dispatchOpenAIResponses(invocation, ctx, chainTransport));

    if (upstreamResult.type !== 'events') return upstreamResult;
    const targetTransport = targetApi === 'openaiResponses'
      ? openAIResponsesTransportForEndpoint(candidate.model.endpoints.openaiResponses)
      : 'standard';
    const chainResult = openAIResponsesTransportOutput(upstreamResult, args.payload, sourceTransport, sourceTransport !== targetTransport);

    if (action === 'compact') {
      const upstreamCompacted = await collectOpenAIResponsesProtocolEventsToResult(chainResult.events);
      return {
        type: 'result',
        result: upstreamCompacted,
        modelIdentity: chainResult.modelIdentity,
        usage: tokenUsageFromBillableUsage((await chainResult.finalMetadata)?.billableUsage),
        performance: chainResult.performance,
        headers: chainResult.headers,
      };
    }
    return chainResult;
  },

  // Narrowing wrapper for cross-protocol translation callers
  // (Anthropic Messages/Gemini generateContent/OpenAI Chat Completions translating into OpenAI Responses) and the
  // native HTTP/WS generate entry — both always run in generate mode and
  // want the ExecuteResult branch. The compact branch is a contract
  // violation here; an interceptor that pivoted generate→compact would
  // surface as a throw, not a silent shape mismatch.
  generate: async (args: OpenAIResponsesAttemptGenerateArgs): Promise<ExecuteResult<ProtocolFrame<OpenAIResponsesStreamEvent>>> => {
    const result = await openaiResponsesAttempt.invoke({ ...args, action: 'generate' });
    if (result.type === 'result') {
      throw new Error('openaiResponsesAttempt.generate received a compact result; an interceptor pivoted generate→compact unexpectedly');
    }
    return result;
  },
};

const dispatchOpenAIResponses = async (
  invocation: OpenAIResponsesInvocation,
  ctx: ChatGatewayCtx,
  sourceTransport: OpenAIResponsesTransport,
): Promise<ExecuteResult<ProtocolFrame<OpenAIResponsesStreamEvent>>> => {
  const { candidate, targetApi } = invocation;
  switch (targetApi) {
  case 'openaiResponses': {
    if (candidate.rules !== undefined) applyRulesToUpstreamOpenAIResponses(invocation.payload, candidate.rules);
    const identity = invocation.payload.client_metadata?.thread_id
      ?? invocation.payload.client_metadata?.session_id
      ?? invocation.headers.get('thread-id')
      ?? invocation.headers.get('session-id')
      ?? invocation.headers.get('session_id')
      ?? undefined;
    const targetTransport = openAIResponsesTransportForEndpoint(candidate.model.endpoints.openaiResponses);
    const targetPayload = withTransportInputErrors(() => convertOpenAIResponsesTransport(
      invocation.payload,
      sourceTransport,
      targetTransport,
      { identity },
    ));
    // Compact drops `stream` and `store` before hitting the wire: `store` is a
    // gateway-only snapshot-persistence hint the upstream compact endpoint
    // rejects, and `stream` is irrelevant on a non-streaming call. The generate
    // branch leaves both fields on the body — every provider's streaming call
    // forces stream=true anyway.
    let body: Omit<CanonicalOpenAIResponsesPayload, 'model'>;
    if (invocation.action === 'compact') {
      const { model: _model, stream: _stream, store: _store, ...rest } = targetPayload;
      body = rest;
    } else {
      const { model: _model, ...rest } = targetPayload;
      body = rest;
    }
    const providerResult = await candidate.provider.instance.callOpenAIResponses(
      providerModelOf(candidate),
      body,
      invocation.action,
      ctx.abortSignal,
      buildUpstreamCallOptions(
        candidate,
        ctx,
        invocation.headers,
        targetTransport === 'lite'
          ? { [OPENAI_RESPONSES_LITE_HEADER]: 'true' }
          : undefined,
      ),
    );
    return await providerOpenAIResponsesResultToExecuteResult(providerResult, candidate, targetApi, ctx);
  }
  case 'anthropicMessages':
    if (invocation.action === 'compact') {
      // The openai-responses-compact-shim is structurally required on non-openai-responses
      // targets and pivots ctx.action to 'generate' before reaching here;
      // landing inside this case with action='compact' means the shim
      // disengaged or was wired out of the chain. A compaction_trigger in
      // input is caught one layer down by the translator's
      // unexpected-input-item guard.
      throw new Error(`openaiResponsesAttempt: action='compact' reached dispatch on targetApi='anthropicMessages' — the openai-responses-compact-shim must engage and pivot the action`);
    }
    return await traverseTranslation(
      invocation.payload,
      p => translateOpenAIResponsesViaAnthropicMessages(p, {
        model: candidate.model.id,
        fallbackMaxOutputTokens: candidate.model.limits.max_output_tokens,
        loadRemoteImage: createExternalImageLoader(ctx.abortSignal),
      }),
      translated => anthropicMessagesAttempt.generate({
        payload: translated, ctx, candidate, headers: invocation.headers, anthropicBeta: [],
      }),
    );
  case 'openaiChatCompletions':
    if (invocation.action === 'compact') {
      throw new Error(`openaiResponsesAttempt: action='compact' reached dispatch on targetApi='openaiChatCompletions' — the openai-responses-compact-shim must engage and pivot the action`);
    }
    return await traverseTranslation(
      invocation.payload,
      p => translateOpenAIResponsesViaOpenAIChatCompletions(p, { model: candidate.model.id }),
      translated => openaiChatCompletionsAttempt.generate({
        payload: translated, ctx, candidate, headers: invocation.headers,
      }),
    );
  default: {
    const exhaustive: never = targetApi;
    throw new Error(`unexpected targetApi '${exhaustive as string}'`);
  }
  }
};

// Lowers a `ProviderOpenAIResponsesResult` into the chain's
// ExecuteResult<ProtocolFrame<OpenAIResponsesStreamEvent>> currency. The compact
// branch synthesizes SSE frames from the envelope so every downstream
// interceptor sees the same event-stream contract regardless of which action
// the provider executed.
const providerOpenAIResponsesResultToExecuteResult = async (
  providerResult: ProviderOpenAIResponsesResult,
  candidate: ModelCandidate,
  targetApi: ChatTargetApi,
  ctx: ChatGatewayCtx,
): Promise<ExecuteResult<ProtocolFrame<OpenAIResponsesStreamEvent>>> => {
  if (providerResult.action === 'generate') {
    return await providerStreamResultToExecuteResult(
      providerResult.ok
        ? { ok: true, events: providerResult.events, modelKey: providerResult.modelKey, ...(providerResult.headers ? { headers: providerResult.headers } : {}) }
        : { ok: false, response: providerResult.response, modelKey: providerResult.modelKey },
      candidate,
      targetApi,
      ctx,
      billableUsageFromOpenAIResponsesEvent,
    );
  }
  const context = upstreamPerformanceContext(ctx, candidate, 'chat');
  if (!providerResult.ok) {
    return { ...(await readUpstreamApiError(providerResult.response, candidate.provider.upstreamId)), performance: context };
  }
  // A native compaction is a turn the upstream ran and charged for, and its
  // body states the counts.
  const modelIdentity = telemetryModelIdentity(candidate, providerResult.modelKey);
  const billableUsage = billableUsageFromOpenAIResponsesResult(providerResult.result);
  return eventResult(
    syntheticEventsFromCompaction(providerResult.result),
    modelIdentity,
    {
      performance: context,
      ...(providerResult.headers ? { headers: providerResult.headers } : {}),
      ...(billableUsage === null ? {} : { finalMetadata: Promise.resolve({ modelIdentity, billableUsage }) }),
    },
  );
};
