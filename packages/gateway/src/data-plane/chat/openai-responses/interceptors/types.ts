import type { ChatGatewayCtx } from '../../shared/gateway-ctx.ts';
import type { Interceptor } from '@floway-dev/interceptor';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import type { ExecuteResult, ResponsesInvocation } from '@floway-dev/provider';

export type { ResponsesInvocation };

export type ResponsesInterceptor = Interceptor<
  ResponsesInvocation,
  ChatGatewayCtx,
  ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>
>;
