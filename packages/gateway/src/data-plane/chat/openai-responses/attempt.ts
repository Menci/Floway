import { klona } from 'klona/json';

import { inputErrorResult } from './errors.ts';
import { openaiResponsesInterceptors } from './interceptors/index.ts';
import type { OpenAIResponsesAttemptResult, OpenAIResponsesInvocation } from './interceptors/types.ts';
import { normalizeAssistantInputText } from './items/normalize-assistant-content.ts';
import { syntheticEventsFromCompaction } from './items/output.ts';
import { billableUsageFromOpenAIResponsesEvent, billableUsageFromOpenAIResponsesResult } from './usage.ts';
import { telemetryModelIdentity, upstreamPerformanceContext } from '../../shared/telemetry/attribution.ts';
import { tokenUsageFromBillableUsage } from '../../shared/telemetry/usage.ts';
import { buildUpstreamCallOptions } from '../../shared/upstream-call-options.ts';
import { anthropicMessagesAttempt } from '../anthropic-messages/attempt.ts';
import { openaiChatCompletionsAttempt } from '../openai-chat-completions/attempt.ts';
import { applyRulesToUpstreamOpenAIResponses } from '../shared/alias-rules.ts';
import { captureFromDump, executeTranslation } from '../shared/execute-translation.ts';
import type { ChatGatewayCtx } from '../shared/gateway-ctx.ts';
import { SidecarDomain } from '../shared/sidecar-codec.ts';
import { chatTargetPicker } from '../shared/target-picker.ts';
import { upstreamStreamResultToExecuteResult } from '../shared/upstream-stream-result.ts';
import { runInterceptors } from '@floway-dev/interceptor';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import { collectOpenAIResponsesProtocolEventsToResult, type CanonicalOpenAIResponsesPayload, type OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import { routeOpenAIResponsesViaAnthropicMessages, routeOpenAIResponsesViaOpenAIChatCompletions, type TranslateInputError } from '@floway-dev/translate';
import { type ModelCandidate, eventResult, readUpstreamApiError, type ChatTargetApi, type ExecuteResult, type UpstreamOpenAIResponsesResult, type OpenAIResponsesAction } from '@floway-dev/upstream';

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

export type OpenAIResponsesAttemptInvokeArgs = OpenAIResponsesAttemptBaseArgs;
type OpenAIResponsesAttemptGenerateArgs = Omit<OpenAIResponsesAttemptInvokeArgs, 'action'>;

// Capture the caller's action before interceptors: invocation action selects upstream execution,
// while caller action selects the returned resource shape.
//
// Compact execution requires a native Responses target. On translated targets, the compact
// shim pivots execution to generate and consumes compact input items before source reading.
//
// Hydration, affinity and persistence belong to the native source edge, so translated inner
// calls cannot own another source protocol's client state.
export const openaiResponsesAttempt = {
  invoke: async (args: OpenAIResponsesAttemptInvokeArgs): Promise<OpenAIResponsesAttemptResult> => {
    const { action, ctx, candidate, headers: sourceHeaders } = args;
    const headers = new Headers(sourceHeaders);
    const targetApi = openaiResponsesTarget.pick(candidate.model.endpoints);
    const payload = { ...klona(args.payload), model: candidate.model.id };
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
    const chainResult = await runInterceptors(invocation, ctx, openaiResponsesInterceptors, async () => {
      const result = await dispatchOpenAIResponses(invocation, ctx);
      return result.type === 'input-error' ? inputErrorResult(result, ctx.attempt.telemetry) : result;
    });

    if (chainResult.type !== 'events') return chainResult;

    if (action === 'compact') {
      const upstreamCompacted = await collectOpenAIResponsesProtocolEventsToResult(chainResult.events);
      return {
        type: 'result',
        result: upstreamCompacted,
        ...(chainResult.http === undefined ? {} : { http: chainResult.http }),
        modelIdentity: chainResult.modelIdentity,
        usage: tokenUsageFromBillableUsage((await chainResult.finalMetadata)?.billableUsage),
        performance: chainResult.performance,
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
  generate: async (args: OpenAIResponsesAttemptGenerateArgs): Promise<ExecuteResult<ProtocolFrame<OpenAIResponsesStreamEventEx>>> => {
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
): Promise<ExecuteResult<ProtocolFrame<OpenAIResponsesStreamEventEx>> | TranslateInputError> => {
  const { candidate, targetApi } = invocation;
  switch (targetApi) {
  case 'openaiResponses': {
    if (candidate.rules !== undefined) applyRulesToUpstreamOpenAIResponses(invocation.payload, candidate.rules);
    // Compact drops `stream` and `store` before hitting the wire: `store` is a
    // gateway-only snapshot-persistence hint the upstream compact endpoint
    // rejects, and `stream` is irrelevant on a non-streaming call. The generate
    // branch leaves both fields on the body — every provider's streaming call
    // forces stream=true anyway.
    let body: Omit<CanonicalOpenAIResponsesPayload, 'model'>;
    if (invocation.action === 'compact') {
      const { model: _model, stream: _stream, store: _store, ...rest } = invocation.payload;
      body = rest;
    } else {
      const { model: _model, ...rest } = invocation.payload;
      body = rest;
    }
    const upstreamResult = await candidate.upstream.instance.callOpenAIResponses(
      candidate.model,
      body,
      invocation.action,
      ctx.abortSignal,
      buildUpstreamCallOptions(candidate, ctx, invocation.headers),
    );
    return await upstreamOpenAIResponsesResultToExecuteResult(upstreamResult, candidate, targetApi, ctx);
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
    return await executeTranslation(
      invocation.payload,
      p => routeOpenAIResponsesViaAnthropicMessages(p, {
        sidecarCodec: ctx.sidecarCodecFactory.codecFor(SidecarDomain.TranslatedAssistantTurn),
        fallbackMaxOutputTokens: candidate.model.limits.max_output_tokens,
      }),
      translated => anthropicMessagesAttempt.generate({
        payload: translated, ctx, candidate, headers: invocation.headers, anthropicBeta: [],
      }),
      captureFromDump(ctx.dump, targetApi),
    );
  case 'openaiChatCompletions':
    if (invocation.action === 'compact') {
      throw new Error(`openaiResponsesAttempt: action='compact' reached dispatch on targetApi='openaiChatCompletions' — the openai-responses-compact-shim must engage and pivot the action`);
    }
    return await executeTranslation(
      invocation.payload,
      p => routeOpenAIResponsesViaOpenAIChatCompletions(p, { sidecarCodec: ctx.sidecarCodecFactory.codecFor(SidecarDomain.TranslatedAssistantTurn) }),
      translated => openaiChatCompletionsAttempt.generate({
        payload: translated, ctx, candidate, headers: invocation.headers,
      }),
      captureFromDump(ctx.dump, targetApi),
    );
  case 'geminiGenerateContent':
    // The picker above never selects Gemini, because no translate pair emits
    // its wire. Refuse rather than translating into a protocol the trip has no
    // route for.
    throw new Error('openaiResponsesAttempt: Gemini generateContent is not a translation target');
  default: {
    const exhaustive: never = targetApi;
    throw new Error(`unexpected targetApi '${exhaustive as string}'`);
  }
  }
};

// Lowers a `UpstreamOpenAIResponsesResult` into the chain's
// ExecuteResult<ProtocolFrame<OpenAIResponsesStreamEvent>> currency. The compact
// branch synthesizes SSE frames from the envelope so every downstream
// interceptor sees the same event-stream contract regardless of which action
// the provider executed.
const upstreamOpenAIResponsesResultToExecuteResult = async (
  upstreamResult: UpstreamOpenAIResponsesResult,
  candidate: ModelCandidate,
  targetApi: ChatTargetApi,
  ctx: ChatGatewayCtx,
): Promise<ExecuteResult<ProtocolFrame<OpenAIResponsesStreamEventEx>>> => {
  if (upstreamResult.action === 'generate') {
    return await upstreamStreamResultToExecuteResult(
      upstreamResult,
      candidate,
      targetApi,
      ctx,
      billableUsageFromOpenAIResponsesEvent,
    );
  }
  const context = upstreamPerformanceContext(ctx, candidate, 'chat');
  if (!upstreamResult.ok) {
    return { ...(await readUpstreamApiError(upstreamResult.http, candidate.upstream.upstreamId)), performance: context };
  }
  // A native compaction is a turn the upstream ran and charged for, and its
  // body states the counts.
  const modelIdentity = telemetryModelIdentity(candidate, upstreamResult.modelKey);
  const billableUsage = billableUsageFromOpenAIResponsesResult(upstreamResult.result);
  return eventResult(
    syntheticEventsFromCompaction(upstreamResult.result),
    modelIdentity,
    {
      performance: context,
      http: upstreamResult.http,
      ...(billableUsage === null ? {} : { finalMetadata: Promise.resolve({ modelIdentity, billableUsage }) }),
    },
  );
};
