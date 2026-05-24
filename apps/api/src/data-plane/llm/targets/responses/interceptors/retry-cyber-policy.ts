import { isObjectLike } from '../../../../../shared/json-helpers.ts';
import type { RequestContext, ResponsesInterceptor, ResponsesInvocation } from '../../../interceptors.ts';
import type { ExecuteResult } from '../../../shared/errors/result.ts';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { ResponsesResult, ResponsesStreamEvent } from '@floway-dev/protocols/responses';

const CYBER_POLICY_ERROR_CODE = 'cyber_policy';
const MAX_CYBER_POLICY_RETRIES = 10;

type ResponsesResultFrames = ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>;

interface FailurePayload {
  error: {
    message: string;
    type: string;
    code: string;
    name?: string;
    stack?: string;
    cause?: unknown;
    source_api?: string;
    target_api?: string;
  };
  response?: Record<string, unknown>;
}

type FailureResult = Exclude<ResponsesResultFrames, { type: 'events' }>;

const stringField = (value: unknown, fallback: string): string => (typeof value === 'string' && value.length > 0 ? value : fallback);

const responseStringField = (response: Record<string, unknown> | undefined, field: string, fallback: string): string => (response ? stringField(response[field], fallback) : fallback);

const debugFieldsFrom = (value: Record<string, unknown>) => ({
  ...(typeof value.name === 'string' ? { name: value.name } : {}),
  ...(typeof value.stack === 'string' ? { stack: value.stack } : {}),
  ...(value.cause !== undefined ? { cause: value.cause } : {}),
  ...(typeof value.source_api === 'string' ? { source_api: value.source_api } : {}),
  ...(typeof value.target_api === 'string' ? { target_api: value.target_api } : {}),
});

const cyberPolicyErrorFrom = (value: unknown): FailurePayload['error'] | undefined => {
  if (!isObjectLike(value) || value.code !== CYBER_POLICY_ERROR_CODE) {
    return undefined;
  }

  return {
    message: stringField(value.message, 'This request was blocked by upstream cyber policy.'),
    type: stringField(value.type, 'invalid_request_error'),
    code: CYBER_POLICY_ERROR_CODE,
  };
};

const cyberPolicyPayloadFrom = (value: unknown): FailurePayload | undefined => {
  if (!isObjectLike(value)) return undefined;
  const error = cyberPolicyErrorFrom(value.error);
  if (error) return { error };

  if (!isObjectLike(value.response)) return undefined;
  const responseError = cyberPolicyErrorFrom(value.response.error);
  return responseError ? { error: responseError, response: value.response } : undefined;
};

const isCyberPolicyPayload = (value: unknown): boolean => cyberPolicyPayloadFrom(value) !== undefined;

const cyberPolicyUpstreamErrorFrom = (result: ResponsesResultFrames): FailurePayload | undefined => {
  if (result.type !== 'upstream-error') return undefined;

  try {
    return cyberPolicyPayloadFrom(JSON.parse(new TextDecoder().decode(result.body)));
  } catch {
    return undefined;
  }
};

const isCyberPolicyUpstreamError = (result: ResponsesResultFrames): boolean => cyberPolicyUpstreamErrorFrom(result) !== undefined;

const failurePayloadFromUpstreamError = (result: Extract<ResponsesResultFrames, { type: 'upstream-error' }>): FailurePayload => {
  const bodyText = new TextDecoder().decode(result.body);
  let response: Record<string, unknown> | undefined;
  let error: Record<string, unknown> | undefined;

  try {
    const parsed = JSON.parse(bodyText);
    if (isObjectLike(parsed)) {
      if (isObjectLike(parsed.response)) {
        response = parsed.response;
        if (isObjectLike(response.error)) error = response.error;
      }
      if (!error && isObjectLike(parsed.error)) error = parsed.error;
    }
  } catch {
    // Raw upstream error bodies are still useful as streamed failure messages.
  }

  return {
    error: {
      message: stringField(error?.message, bodyText || `Upstream Responses request failed with HTTP ${result.status}.`),
      type: stringField(error?.type, 'upstream_error'),
      code: stringField(error?.code, `http_${result.status}`),
      ...(error ? debugFieldsFrom(error) : {}),
    },
    ...(response ? { response } : {}),
  };
};

const failurePayloadFromResult = (result: FailureResult): FailurePayload => {
  if (result.type === 'upstream-error') {
    return failurePayloadFromUpstreamError(result);
  }

  return {
    error: {
      message: result.error.message,
      type: result.error.type,
      code: result.error.type,
      name: result.error.name,
      ...(result.error.stack !== undefined ? { stack: result.error.stack } : {}),
      ...(result.error.cause !== undefined ? { cause: result.error.cause } : {}),
      source_api: result.error.source_api,
      ...(result.error.target_api !== undefined ? { target_api: result.error.target_api } : {}),
    },
  };
};

const failureFrameFromResult = (invocation: ResponsesInvocation, result: FailureResult): ProtocolFrame<ResponsesStreamEvent> => {
  const payload = failurePayloadFromResult(result);

  return eventFrame({
    type: 'response.failed',
    response: {
      id: responseStringField(payload.response, 'id', 'resp_upstream_failed'),
      object: responseStringField(payload.response, 'object', 'response'),
      model: responseStringField(payload.response, 'model', invocation.payload.model),
      status: 'failed',
      output: [],
      output_text: '',
      error: payload.error,
    },
  } as ResponsesStreamEvent);
};

const isCyberPolicyResponse = (response: unknown): response is ResponsesResult =>
  isObjectLike(response) && response.status === 'failed' && isObjectLike(response.error) && response.error.code === CYBER_POLICY_ERROR_CODE;

const isCyberPolicyEvent = (event: ResponsesStreamEvent): boolean => isCyberPolicyPayload(event) || isCyberPolicyResponse((event as { response?: unknown }).response);

const isCyberPolicyFrame = (frame: ProtocolFrame<ResponsesStreamEvent>): boolean => frame.type === 'event' && isCyberPolicyEvent(frame.event);

const isRetryProbePrologue = (frame: ProtocolFrame<ResponsesStreamEvent>): boolean =>
  frame.type === 'event' && (frame.event.type === 'response.created' || frame.event.type === 'response.in_progress');

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

type EventsResult = Extract<ResponsesResultFrames, { type: 'events' }>;

const isDownstreamAborted = (request: RequestContext): boolean => request.downstreamAbortSignal?.aborted === true;

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
  invocation: ResponsesInvocation,
  request: RequestContext,
  run: () => Promise<ResponsesResultFrames>,
  initialResult: EventsResult,
  returned: EventsResult,
): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {
  let result: ResponsesResultFrames = initialResult;

  for (let attempt = 0; attempt <= MAX_CYBER_POLICY_RETRIES; attempt++) {
    updateStreamingResultIdentity(returned, result);

    if (result.type !== 'events') {
      if (isCyberPolicyUpstreamError(result) && attempt < MAX_CYBER_POLICY_RETRIES && !isDownstreamAborted(request)) {
        result = await run();
        continue;
      }

      if (isDownstreamAborted(request)) return;
      yield failureFrameFromResult(invocation, result);
      return;
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
      if (attempt >= MAX_CYBER_POLICY_RETRIES || isDownstreamAborted(request)) {
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
 * Keep this at the `/responses` target boundary because both HTTP error bodies
 * and streaming `response.failed` payloads are upstream protocol details. The
 * interceptor suppresses retried failed attempts and passes through either the
 * first successful attempt or the final policy failure.
 *
 * References:
 * - https://openai.com/index/trusted-access-for-cyber/
 * - https://deploymentsafety.openai.com/gpt-5-3-codex/cybersecurity
 *
 * TODO: Add gateway-side recent cyber-policy retry/error-log storage so
 * operators can inspect detailed upstream failures, matching the web-search shim
 * error-log TODO pattern.
 */
export const withCyberPolicyRetried: ResponsesInterceptor = async (ctx, request, run) => {
  if (!ctx.enabledFlags.has('retry-cyber-policy')) return await run();

  let finalResult: ResponsesResultFrames | undefined;

  for (let attempt = 0; attempt <= MAX_CYBER_POLICY_RETRIES; attempt++) {
    const current = await run();
    finalResult = current;

    if (current.type === 'events') {
      const returned: EventsResult = {
        ...current,
        modelIdentity: { ...current.modelIdentity },
      };
      returned.events = retryCyberPolicyEvents(ctx, request, run, current, returned);
      return returned;
    }

    if (!isCyberPolicyUpstreamError(current) || isDownstreamAborted(request)) {
      return current;
    }
  }

  return finalResult!;
};
