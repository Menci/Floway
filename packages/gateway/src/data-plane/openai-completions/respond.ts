import type { TokenUsage } from '../../repo/types.ts';
import { isOpenAIErrorPayload, openaiSseFailure } from '../shared/openai-errors.ts';
import { passthroughApiError, type PassthroughResponseStrategyContext } from '../shared/passthrough-serve.ts';
import { serializeSseFrame, serveSse } from '../shared/sse.ts';
import { recordFailedRequest } from '../shared/telemetry/performance.ts';
import { recordSseOutcome, settle } from '../shared/telemetry/settle.ts';
import { forwardUpstreamHeaders, forwardUpstreamResponse } from '../shared/upstream-response.ts';
import { doneFrame, eventFrame, parseSSEStream, parseTargetStreamFrames, type ProtocolFrame, sseFrame } from '@floway-dev/protocols/common';

export const respondOpenAICompletionsSse = (
  { c, ctx, sourceApi, response, performance, identity }: PassthroughResponseStrategyContext,
  transformFrame: (frame: ProtocolFrame<unknown>) => ProtocolFrame<unknown> | null,
  settleUsage: () => TokenUsage | null,
): Response => {
  if (!response.ok) {
    recordFailedRequest(ctx, performance);
    ctx.dump?.error('upstream', identity.upstream);
    return forwardUpstreamResponse(response);
  }
  if (!response.body) {
    ctx.dump?.failed(`${sourceApi} streaming upstream returned no body`);
    recordFailedRequest(ctx, performance);
    forwardUpstreamHeaders(c, response.headers);
    return passthroughApiError(c, 'Upstream returned a streaming response with no body.', 502);
  }

  const events = parseTargetStreamFrames<unknown>(
    parseSSEStream(response.body, { signal: ctx.abortSignal }),
    { protocol: sourceApi },
  );
  return serveSse(c, {
    http: response,
    events,
    downstreamAbortController: ctx.downstreamAbortController,
    protocol: {
      encode: parsed => {
        if (parsed.type === 'error') throw new Error(parsed.cause.message, { cause: parsed.cause.cause });
        const input = parsed.type === 'done' ? doneFrame() : eventFrame(parsed.data);
        ctx.dump?.frame(input);
        if (input.type === 'done') return { wire: serializeSseFrame(sseFrame('[DONE]')), end: { type: 'completed' } };
        if (isOpenAIErrorPayload(input.event)) return { wire: serializeSseFrame(sseFrame(JSON.stringify(input.event))), end: { type: 'protocol-error' } };
        const output = transformFrame(input);
        return { wire: output?.type === 'event' ? serializeSseFrame(sseFrame(JSON.stringify(output.event))) : null };
      },
      eof: () => ({ type: 'premature-eof', error: new Error('OpenAI Completions stream ended without a [DONE] sentinel.') }),
      failure: error => openaiSseFailure(ctx, error),
    },
    settle: outcome => {
      const usage = settleUsage();
      const failed = recordSseOutcome(ctx, outcome, identity, usage);
      settle(ctx, performance, identity, usage, failed);
    },
  });
};
