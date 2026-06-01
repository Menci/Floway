import type { BackgroundScheduler } from '../../runtime/background.ts';
import type { ModelProvider, ProviderTargetInterceptors, UpstreamModel } from '../providers/types.ts';
import type { ExecuteResult } from './shared/errors/result.ts';
import type { ChatCompletionsStreamEvent, ChatCompletionsPayload } from '@floway-dev/protocols/chat-completions';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiPayload, GeminiStreamEvent } from '@floway-dev/protocols/gemini';
import type { MessagesPayload, MessagesStreamEvent } from '@floway-dev/protocols/messages';
import type { ResponsesPayload, RawResponsesStreamEvent } from '@floway-dev/protocols/responses';

export type LlmSourceApi = 'messages' | 'responses' | 'chat-completions' | 'gemini';

export type LlmTargetApi = 'messages' | 'responses' | 'chat-completions';

/**
 * Per-attempt bag the Responses pipeline uses to thread server-tool shim
 * state across layers (source serve → source interceptors → persistence)
 * within a single provider-binding attempt. The whole bag is reassigned at
 * the top of every attempt, so a failed attempt's writes don't leak forward.
 *
 * - `privatePayload`: wire item id → shim-defined opaque blob, round-tripped
 *   verbatim by persistence as `payload.private`. The shape is shim-specific.
 * - `newSyntheticIds`: gateway-minted item ids no upstream issued (e.g. a
 *   server-tool shim's `web_search_call`), persisted as non_affinity.
 */
export interface StatefulResponsesContext {
  readonly privatePayload: Map<string, unknown>;
  readonly newSyntheticIds: Set<string>;
}

/**
 * Per-HTTP-request scope. Constructed once in `createRequestContext` and
 * threaded through every layer (source interceptors, target emits, target
 * interceptors, telemetry). Holds both immutable identities/adapters and
 * mutable per-request bags that cross-layer producers and consumers share.
 *
 * Anything that varies per provider-binding attempt belongs on `Invocation`,
 * not here. `statefulResponsesContext` is the one exception: the serve loop
 * reassigns it per attempt so cross-layer readers outside `Invocation`
 * plumbing (output.ts:buildRow, source-interceptor `transformItems`) reach
 * it via the only handle they have. Read it through
 * `request.statefulResponsesContext` at access time; never capture the
 * inner object in a closure or background task — that snapshot belongs to
 * one attempt only.
 *
 * Telemetry recording is done via global helpers that accept `apiKeyId` (and
 * `scheduleBackground` for performance) explicitly so call sites stay visible
 * about the no-op when the request has no API key (ADMIN_KEY playground path).
 */
export interface RequestContext {
  readonly requestStartedAt: number;
  readonly apiKeyId?: string;
  // null = Default mode (inherit global upstream order).
  readonly apiKeyUpstreamIds?: readonly string[] | null;
  readonly runtimeLocation: string;
  readonly scheduleBackground?: BackgroundScheduler;
  readonly downstreamAbortSignal?: AbortSignal;
  readonly clientStream: boolean;
  statefulResponsesContext: StatefulResponsesContext;
}

/**
 * Per-provider-binding-attempt request-side description. Rebuilt for every
 * binding the planner tries inside one HTTP request.
 *
 * - sourceApi / targetApi: the protocol the client spoke and the protocol
 *   the planner picked for this binding.
 * - model: the resolved public model id.
 * - upstream / upstreamModel / provider: the planner's binding choice.
 * - enabledFlags: the effective flag set for this binding.
 * - targetInterceptors: the provider-registered target interceptor table.
 * - payload: the source-shape request body, mutable so source interceptors
 *   can clean it.
 * - headers: mutable HTTP-header bag the source serve seeds empty and target
 *   interceptors populate. The provider's upstream call passes it through to
 *   the wire fetch unchanged, so workarounds that only need to set or drop a
 *   header (vision, initiator, anthropic-beta, ...) stay at the owning
 *   interceptor boundary instead of widening the provider call signature.
 *
 * Named `Invocation` (not `Exchange`) because "exchange" implies a
 * request/response pair; this object carries only the request side plus the
 * planner's binding decisions. The response flows through `ExecuteResult`,
 * not back through `Invocation`.
 *
 * apiKeyId, downstreamAbortSignal, telemetry recorders are NOT on
 * `Invocation` — they belong on `RequestContext` because they don't change
 * when the planner tries another binding.
 */
export interface Invocation<TPayload> {
  readonly sourceApi: LlmSourceApi;
  readonly targetApi: LlmTargetApi;
  readonly model: string;
  readonly upstream: string;
  readonly upstreamModel: UpstreamModel;
  readonly provider: ModelProvider;
  readonly enabledFlags: ReadonlySet<string>;
  readonly targetInterceptors?: ProviderTargetInterceptors;
  payload: TPayload;
  headers: Record<string, string>;
}

export interface MessagesInvocation extends Invocation<MessagesPayload> {
  readonly anthropicBeta?: readonly string[];
}
export type ResponsesInvocation = Invocation<ResponsesPayload>;
export type ChatCompletionsInvocation = Invocation<ChatCompletionsPayload>;
export type GeminiInvocation = Invocation<GeminiPayload>;

export type InterceptorRun<TResult> = () => Promise<TResult>;

export type Interceptor<TContext, TRequest, TResult> = (ctx: TContext, request: TRequest, run: InterceptorRun<TResult>) => Promise<TResult>;

export const runInterceptors = async <TContext, TRequest, TResult>(
  ctx: TContext,
  request: TRequest,
  interceptors: readonly Interceptor<TContext, TRequest, TResult>[],
  terminal: InterceptorRun<TResult>,
): Promise<TResult> => {
  const run = (index: number): Promise<TResult> => (index < interceptors.length ? interceptors[index](ctx, request, () => run(index + 1)) : terminal());

  return await run(0);
};

export type MessagesInterceptor = Interceptor<MessagesInvocation, RequestContext, ExecuteResult<ProtocolFrame<MessagesStreamEvent>>>;
export type ResponsesInterceptor = Interceptor<ResponsesInvocation, RequestContext, ExecuteResult<ProtocolFrame<RawResponsesStreamEvent>>>;
export type ChatCompletionsInterceptor = Interceptor<ChatCompletionsInvocation, RequestContext, ExecuteResult<ProtocolFrame<ChatCompletionsStreamEvent>>>;
export type GeminiInterceptor = Interceptor<GeminiInvocation, RequestContext, ExecuteResult<ProtocolFrame<GeminiStreamEvent>>>;

// count_tokens is a one-shot, non-streaming HTTP exchange — the terminal
// returns the raw upstream `Response` directly, with no protocol-frame
// translation in between. The interceptor chain still runs against a
// `MessagesInvocation` so payload-shaped reads (vision detection, last-message
// initiator classification, anthropic-beta filtering) match the chat path
// exactly. Interceptors registered here MUST be pure header/payload mutators;
// post-`run()` result inspection is not portable to this result type.
export type MessagesCountTokensInterceptor = Interceptor<MessagesInvocation, RequestContext, Response>;
