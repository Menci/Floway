import type { ResponsesInterceptor } from './types.ts';
import { isObjectLike } from '../../../../shared/json-helpers.ts';
import type { GatewayCtx } from '../../shared/gateway-ctx.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import type { ExecuteResult } from '@floway-dev/provider';

const CYBER_POLICY_ERROR_CODE = 'cyber_policy';
const MAX_CYBER_POLICY_RETRIES = 10;

type ResponsesResultFrames = ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>;
type EventsResult = Extract<ResponsesResultFrames, { type: 'events' }>;
type FailureResult = Exclude<ResponsesResultFrames, { type: 'events' }>;

// Both the HTTP error body shape `{error: {code}}` and the streamed
// `response.failed` event shape `{response: {error: {code}}}` carry the
// cyber_policy marker; check both.
const valueHasCyberPolicyCode = (value: unknown): boolean => {
  if (!isObjectLike(value)) return false;
  if (isObjectLike(value.error) && value.error.code === CYBER_POLICY_ERROR_CODE) return true;
  if (isObjectLike(value.response) && isObjectLike(value.response.error) && value.response.error.code === CYBER_POLICY_ERROR_CODE) return true;
  return false;
};

const isCyberPolicyUpstreamError = (result: ResponsesResultFrames): boolean => {
  if (result.type !== 'api-error' || result.source !== 'upstream') return false;
  try {
    return valueHasCyberPolicyCode(JSON.parse(new TextDecoder().decode(result.body)));
  } catch {
    return false;
  }
};

const isCyberPolicyFrame = (frame: ProtocolFrame<ResponsesStreamEvent>): boolean =>
  frame.type === 'event' && valueHasCyberPolicyCode(frame.event);

const isRetryProbePrologue = (frame: ProtocolFrame<ResponsesStreamEvent>): boolean =>
  frame.type === 'event' && (frame.event.type === 'response.created' || frame.event.type === 'response.in_progress');

const isDownstreamAborted = (ctx: GatewayCtx): boolean => ctx.abortSignal?.aborted === true;

// Anything other than another cyber_policy retry is outside this middleware's
// scope. Throw with the raw upstream payload so the source layer's stream
// error handler surfaces it verbatim instead of having this middleware
// invent a `response.failed` envelope around it.
const unexpectedRetryFailureError = (result: FailureResult): Error => {
  if (result.type === 'api-error') {
    const body = new TextDecoder().decode(result.body);
    return new Error(`cyber-policy retry produced HTTP ${result.status} (${result.source}): ${body || '<empty body>'}`);
  }
  return new Error(`cyber-policy retry produced internal error: ${result.error.message}`, { cause: result.error });
};

const replayBufferedThenRest = async function* (
  buffered: readonly ProtocolFrame<ResponsesStreamEvent>[],
  first: ProtocolFrame<ResponsesStreamEvent>,
  iterator: AsyncIterator<ProtocolFrame<ResponsesStreamEvent>>,
): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {
  let done = false;

  try {
    yield* buffered;
    yield first;

    while (true) {
      const next = await iterator.next();
      if (next.done) {
        done = true;
        return;
      }

      yield next.value;
    }
  } finally {
    if (!done) await iterator.return?.();
  }
};

const updateStreamingResultIdentity = (returned: EventsResult, latest: ResponsesResultFrames): void => {
  if (latest.performance) {
    returned.performance = latest.performance;
  } else {
    delete returned.performance;
  }

  if (latest.type !== 'events') return;
  returned.modelIdentity.model = latest.modelIdentity.model;
  returned.modelIdentity.upstream = latest.modelIdentity.upstream;
  returned.modelIdentity.modelKey = latest.modelIdentity.modelKey;
};

const retryCyberPolicyEvents = async function* (
  ctx: GatewayCtx,
  run: () => Promise<ResponsesResultFrames>,
  initialResult: EventsResult,
  returned: EventsResult,
): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {
  let result: ResponsesResultFrames = initialResult;

  for (let attempt = 0; attempt <= MAX_CYBER_POLICY_RETRIES; attempt++) {
    updateStreamingResultIdentity(returned, result);

    if (result.type !== 'events') {
      if (isCyberPolicyUpstreamError(result) && attempt < MAX_CYBER_POLICY_RETRIES && !isDownstreamAborted(ctx)) {
        result = await run();
        continue;
      }

      if (isDownstreamAborted(ctx)) return;
      throw unexpectedRetryFailureError(result);
    }

    const iterator = result.events[Symbol.asyncIterator]();
    const buffered: ProtocolFrame<ResponsesStreamEvent>[] = [];

    while (true) {
      const next = await iterator.next();
      if (next.done) {
        yield* buffered;
        return;
      }

      const frame = next.value;
      if (!isCyberPolicyFrame(frame)) {
        if (isRetryProbePrologue(frame)) {
          buffered.push(frame);
          continue;
        }

        yield* replayBufferedThenRest(buffered, frame, iterator);
        return;
      }

      // Retry only before any failed attempt frames reach the source pipeline.
      // This lazy probe buffers synthetic JSON fallback prologues so a retryable
      // terminal policy failure cannot leak `response.created` first.
      await iterator.return?.();
      if (attempt >= MAX_CYBER_POLICY_RETRIES || isDownstreamAborted(ctx)) {
        yield* buffered;
        yield frame;
        return;
      }

      result = await run();
      break;
    }
  }
};

/**
 * Some OpenAI-compatible GPT-5.x Responses paths are prone to intermittent
 * false-positive `cyber_policy` failures for Codex traffic. The Copilot
 * provider enables this by default because that upstream cannot be enrolled in
 * the Trusted Access for Cyber program named in OpenAI's client-facing text;
 * custom upstreams only run it when an admin explicitly enables the flag.
 *
 * Scope is intentionally narrow: detect cyber_policy failures, retry up to
 * MAX_CYBER_POLICY_RETRIES, and pass through either the first successful
 * attempt or the final cyber_policy frame verbatim. Anything else a retry
 * produces (non-cyber_policy HTTP error, internal error) is not this
 * middleware's concern — it throws so the source layer's stream error
 * handler surfaces the raw payload, rather than fabricating a
 * `response.failed` envelope here.
 *
 * Keep this at the Responses interceptor layer because both HTTP error bodies
 * and streaming `response.failed` payloads are upstream protocol details.
 *
 * References:
 * - https://openai.com/index/trusted-access-for-cyber/
 * - https://deploymentsafety.openai.com/gpt-5-3-codex/cybersecurity
 *
 * TODO: Add gateway-side recent cyber-policy retry/error-log storage so
 * operators can inspect detailed upstream failures.
 */
export const withCyberPolicyRetried: ResponsesInterceptor = async (ctx, gatewayCtx, run) => {
  if (!ctx.candidate.model.enabledFlags.has('retry-cyber-policy')) return await run();

  let finalResult: ResponsesResultFrames | undefined;

  for (let attempt = 0; attempt <= MAX_CYBER_POLICY_RETRIES; attempt++) {
    const current = await run();
    finalResult = current;

    if (current.type === 'events') {
      const returned: EventsResult = {
        ...current,
        modelIdentity: { ...current.modelIdentity },
      };
      returned.events = retryCyberPolicyEvents(gatewayCtx, run, current, returned);
      return returned;
    }

    if (!isCyberPolicyUpstreamError(current) || isDownstreamAborted(gatewayCtx)) {
      return current;
    }
  }

  return finalResult!;
};
