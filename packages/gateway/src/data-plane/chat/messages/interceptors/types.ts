import type { GatewayCtx } from '../../../shared/gateway-ctx.ts';
import type { Interceptor } from '@floway-dev/interceptor';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { MessagesStreamEvent } from '@floway-dev/protocols/messages';
import type { ExecuteResult, MessagesInvocation } from '@floway-dev/provider';

export type { MessagesInvocation };

export type MessagesInterceptor = Interceptor<
  MessagesInvocation,
  GatewayCtx,
  ExecuteResult<ProtocolFrame<MessagesStreamEvent>>
>;

// count_tokens is a one-shot, non-streaming HTTP exchange whose terminal
// returns the raw upstream `Response`. Shared entries must therefore be pure
// header/payload mutators; post-run stream inspection is not portable to this
// result type.
export type MessagesCountTokensInterceptor = Interceptor<
  MessagesInvocation,
  GatewayCtx,
  Response
>;
