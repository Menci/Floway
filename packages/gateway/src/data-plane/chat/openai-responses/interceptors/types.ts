import type { TokenUsage } from '../../../../repo/types.ts';
import type { ChatGatewayCtx } from '../../shared/gateway-ctx.ts';
import type { Interceptor } from '@floway-dev/interceptor';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIResponsesResult, OpenAIResponsesStreamEvent } from '@floway-dev/protocols/openai-responses';
import type { EventResultMetadata, ExecuteResult, OpenAIResponsesInvocation, TelemetryModelIdentity } from '@floway-dev/provider';

export type { OpenAIResponsesInvocation };

// The chain runner produces an event stream for both actions — the attempt
// drains it into a single non-streaming result when the caller's intent action
// was 'compact', and serve completes that result into the compaction resource.
// `modelIdentity`, `usage`, and `performance` carry the per-turn attribution
// forward so the http layer records the success path identically to streaming
// generate.
// The non-streaming result is parameterized because `/responses/compact`
// answers with `CompactResource` rather than the response resource, and its
// own completion narrows the type further.
export type OpenAIResponsesAttemptResult<Result = OpenAIResponsesResult> =
  | ExecuteResult<ProtocolFrame<OpenAIResponsesStreamEvent>>
  | {
    readonly type: 'result';
    readonly result: Result;
    readonly modelIdentity: TelemetryModelIdentity;
    readonly usage: TokenUsage | null;
    readonly performance: EventResultMetadata['performance'];
  };

export type OpenAIResponsesInterceptor = Interceptor<
  OpenAIResponsesInvocation,
  ChatGatewayCtx,
  ExecuteResult<ProtocolFrame<OpenAIResponsesStreamEvent>>
>;
