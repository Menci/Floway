import type { TokenUsage } from '../../../../repo/types.ts';
import type { ChatGatewayCtx } from '../../shared/gateway-ctx.ts';
import type { Interceptor } from '@floway-dev/interceptor';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ResponsesResult, ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import type { EventResultMetadata, ExecuteResult, ResponsesInvocation, TelemetryModelIdentity } from '@floway-dev/provider';

export type { ResponsesInvocation };

// The chain runner produces an event stream for both actions — the attempt
// post-processes it into a single `response.compaction` envelope when the
// caller's intent action was 'compact'. `modelIdentity`, `usage`, and
// `performance` carry the per-turn attribution forward so the http layer
// records the success path identically to streaming generate.
// The non-streaming branch is parameterized because `/responses/compact`
// answers with a different resource than `/responses` does, and the compact
// route's own egress narrows it further.
export type ResponsesAttemptResult<Result = ResponsesResult> =
  | ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>
  | {
    readonly type: 'result';
    readonly result: Result;
    readonly modelIdentity: TelemetryModelIdentity;
    readonly usage: TokenUsage | null;
    readonly performance: EventResultMetadata['performance'];
  };

export type ResponsesInterceptor = Interceptor<
  ResponsesInvocation,
  ChatGatewayCtx,
  ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>
>;
