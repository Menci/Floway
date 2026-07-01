import type { TokenUsage } from '../../../../repo/types.ts';
import type { ChatGatewayCtx } from '../../shared/gateway-ctx.ts';
import type { Interceptor } from '@floway-dev/interceptor';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ResponsesResult, ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import type { ExecuteResult, ResponsesInvocation as WireResponsesInvocation, TelemetryModelIdentity } from '@floway-dev/provider';
import type { CanonicalResponsesPayload } from '@floway-dev/translate/via-responses/responses-items';

export interface ResponsesInvocation extends Omit<WireResponsesInvocation, 'payload'> {
  payload: CanonicalResponsesPayload;
}

// The chain runner produces an event stream for both actions — the attempt
// post-processes it into a single `response.compaction` envelope when the
// caller's intent action was 'compact'. `modelIdentity` and `usage` carry
// the per-turn attribution forward so the http layer's `ctx.dump` records
// the success path identically to streaming generate.
export type ResponsesAttemptResult =
  | ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>
  | {
    readonly type: 'result';
    readonly result: ResponsesResult;
    readonly modelIdentity: TelemetryModelIdentity;
    readonly usage: TokenUsage | null;
  };

export type ResponsesInterceptor = Interceptor<
  ResponsesInvocation,
  ChatGatewayCtx,
  ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>
>;
