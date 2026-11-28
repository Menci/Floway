import type { GatewayCtx } from '../../../shared/gateway-ctx.ts';
import type { Interceptor, InterceptorRun } from '@floway-dev/interceptor';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';
import type { ApiErrorResult, ExecuteResult, GeminiGenerateContentInvocation, InternalErrorResult, PlainResult } from '@floway-dev/upstream';

export type GeminiGenerateContentInterceptor = Interceptor<
  GeminiGenerateContentInvocation,
  GatewayCtx,
  ExecuteResult<ProtocolFrame<GeminiGenerateContentStreamEvent>>
>;

// A payload-shape cleanup rewrites the invocation and passes the chain result
// through untouched. Typing it generically lets generate and countTokens run
// the same entry without a cast: each chain instantiates the result it returns.
export type GeminiGenerateContentShapeCleanup = <R>(
  ctx: GeminiGenerateContentInvocation,
  env: GatewayCtx,
  run: InterceptorRun<R>,
) => Promise<R>;

// countTokens returns an upstream-shaped HTTP body, an API error, or a gateway
// internal error. The interceptor chain still uses GeminiGenerateContentInvocation
// so payload-shaped reads stay symmetric with the generate path. Interceptors
// registered here MUST be pure header/payload mutators; post-`run()` result
// inspection is not portable to this result type.
export type GeminiGenerateContentCountTokensInterceptor = Interceptor<
  GeminiGenerateContentInvocation,
  GatewayCtx,
  ApiErrorResult | InternalErrorResult | PlainResult
>;
