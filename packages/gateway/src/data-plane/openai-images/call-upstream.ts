import type { Fields, OpenAIImagesFrames } from './facts.ts';
import type { UsageQuantities } from '../../repo/types.ts';
import type { BillableEntity, Failure } from '../pipeline/facts.ts';
import { providerEntry } from '../pipeline/provider-entry.ts';
import { providerUsage } from '../pipeline/provider-usage.ts';
import type { StreamOutcome } from '../pipeline/serve.ts';
import type { GatewayServices } from '../pipeline/services.ts';
import { dialFailure, readUpstreamBody, spentBody, retainReader } from '../pipeline/upstream-body.ts';
import { upstreamPerformanceContext, telemetryModelIdentity } from '../shared/telemetry/attribution.ts';
import { recordStream } from '@floway-dev/dump';
import { exchangeResponse } from '@floway-dev/http/pipeline';
import { defineStage, move, setRelease, defer, type Deferred } from '@floway-dev/pipeline';
import { upstreamErrorMessage, isEventStreamMediaType, eventFrame, mediaTypeEssence, parseDecimalString } from '@floway-dev/protocols/common';
import { parseOpenAIImagesResponse, parseOpenAIImagesStream, isOpenAIImagesTerminalEvent, parseOpenAIImagesUsage, OPENAI_IMAGES_MISSING_TERMINAL_MESSAGE, type OpenAIImagesOperation, type CanonicalOpenAIImagesResponse, type CanonicalOpenAIImagesUsage, type CanonicalOpenAIImagesEditsRequest, type OpenAIImagesEditImage, type OpenAIImageEditReference } from '@floway-dev/protocols/openai-images';
import { isBase64ImageDataUrl, type ProviderRequest, type ProviderResponse, type ProviderOperationPayloads, type PerformanceOperation, type TelemetryModelIdentity, type OpenAIImagesEditsRequest, type OpenAIImagesEditsSource } from '@floway-dev/provider';

/** A stream as a value the record can hold, as a wrapper around the generator rather than the
 *  generator itself. What the wrapper says is where the resource is: the one resource in an
 *  OpenAI Images run is the upstream's body at `response.http.body`, claimed with `own()`, and
 *  this keeps a frame view from reading as another. */

const PERFORMANCE_OPERATION = {
  generations: 'image_generation',
  edits: 'image_edit',
} as const satisfies Record<OpenAIImagesOperation, PerformanceOperation>;

/**
 * The ending. It dials, reads what came back on the shape the request asked for, and provides
 * the canonical answer, the headers that came with it, the raw HTTP body beneath it, and what
 * the call is billable for. A failure is a value: an upstream that refused, and one that
 * answered with something this protocol cannot read, are both outcomes the fork above can take
 * to the next candidate rather than faults that end the run.
 */
export const callOpenAIImagesUpstream = defineStage<
  Fields<'ingress.openaiImages.wantsStream' | 'request.openaiImages.canonical' | 'route.attempt' | 'ingress.http.headers'>,
  ProviderRequest<ProviderOperationPayloads['openaiImagesGenerations' | 'openaiImagesEdits']>,
  ProviderResponse,
  Fields<'response.openaiImages.canonical' | 'response.openaiImages.streamedUsage' | 'response.http.status' | 'response.http.headers'
    | 'response.http.body' | 'response.usage.billable'>,
  GatewayServices
>({
  name: 'callOpenAIImagesUpstream',
  into: {
    request: { needs: ['ingress.openaiImages.wantsStream', 'request.openaiImages.canonical', 'route.attempt', 'ingress.http.headers'], consumes: [], provides: ['request.provider.model', 'request.provider.payload', 'request.http.callId', 'request.http.headers'] },
    response: { needs: ['response.http.exchange', 'response.provider.modelKey', 'response.provider.called', 'response.provider.previousCalls', 'response.http.body'], consumes: ['response.http.exchange', 'response.provider.modelKey', 'response.provider.called', 'response.provider.previousCalls'], provides: ['response.openaiImages.canonical', 'response.openaiImages.streamedUsage', 'response.http.status', 'response.http.headers', 'response.http.body', 'response.usage.billable'] },
  },
  execute: async (facts, next, use) => {
    const candidate = use.resolveAttempt(facts['route.attempt']);
    const request = facts['request.openaiImages.canonical'];
    // Attribution is set before the dial, so an attempt that never completes still names the
    // candidate it was made against rather than the one tried before it.
    use.gateway.attempt.telemetry = upstreamPerformanceContext(use.gateway, candidate, PERFORMANCE_OPERATION[request.operation]);

    const back = request.operation === 'generations'
      ? await next(providerEntry(facts, candidate, request.parameters), candidate.provider.pipelines.openaiImagesGenerations!)
      : await next(providerEntry(facts, candidate, providerEditsRequest(request)), candidate.provider.pipelines.openaiImagesEdits!);
    const { 'response.http.exchange': exchange, 'response.provider.modelKey': modelKey, 'response.provider.called': wasCalled, 'response.provider.previousCalls': _previousCalls, ...rest } = back;
    if (exchange.type === 'transportFailure') {
      return move({
        ...rest,
        'response.openaiImages.canonical': dialFailure(exchange.error),
        'response.openaiImages.streamedUsage': null,
        'response.http.status': 502,
        'response.http.headers': [],
        'response.http.body': spentBody(null),
        'response.usage.billable': providerUsage(candidate, back, []),
      });
    }
    const result = { response: exchangeResponse(exchange), modelKey };

    const identity = telemetryModelIdentity(candidate, result.modelKey);
    // What came back, unfiltered: the edge is where a client's view of it is decided.
    const headers = [...result.response.headers];
    // An entity with no quantities is how "the upstream was called and reported nothing" is
    // said, which is a different situation from reporting zero.
    const called: readonly BillableEntity[] = wasCalled ? [{ identity, quantities: {} }] : [];
    const read = (canonical: CanonicalOpenAIImagesResponse | Failure, billable: readonly BillableEntity[]) => move({
      ...rest,
      'response.openaiImages.canonical': canonical,
      'response.openaiImages.streamedUsage': null,
      'response.http.status': result.response.status,
      'response.http.headers': headers,
      'response.http.body': spentBody(exchange.body),
      'response.usage.billable': providerUsage(candidate, back, billable),
    });

    if (!result.response.ok) {
      await use.log.warn('upstream refused', { status: result.response.status });
      // An upstream error body is JSON like any other body. Reading it here is also what
      // leaves a losing attempt with nothing open behind it.
      spentBody(exchange.body);
      const body = await readUpstreamBody(result.response);
      return read({
        status: result.response.status,
        message: upstreamErrorMessage(body.json) ?? body.text,
        ...('json' in body ? { body: body.json } : {}),
      }, called);
    }

    const mediaType = result.response.headers.get('content-type');
    // Both halves have to hold. `stream` is what the client asked for, and an upstream that
    // ignores it answers the single JSON body the arm below reads — so what settles which
    // shape arrived is the media type, and what settles which shape the client is owed is the
    // request.
    if (facts['ingress.openaiImages.wantsStream'] && isEventStreamMediaType(mediaType)) {
      if (result.response.body === null) {
        return read({ status: 502, message: 'Upstream returned a streaming response with no body.' }, called);
      }
      // Usage is observed here, closest to the upstream and on the protocol it spoke, by
      // folding the events as they pass — so the reading costs one pass and the client's own
      // stream is what drives it. What it finds arrives with the completed event, long after
      // this stage has handed up, which is why the entity above carries no quantities.
      const metered = meterFrames(result.response.body, identity, use.gateway.abortSignal);
      setRelease(exchange.body!, async () => { for await (const _event of metered.frames) { /* drain */ } });
      return move({
        ...rest,
        // This protocol's stream is bare events rather than protocol frames, so the record is
        // told how one becomes a frame instead of being left to assume.
        'response.openaiImages.canonical': recordStream(metered.frames, use.gateway.dump, eventFrame),
        'response.openaiImages.streamedUsage': defer(metered.outcome.then(outcome => ({ ...outcome, billable: providerUsage(candidate, back, outcome.billable) }))),
        'response.http.status': result.response.status,
        'response.http.headers': headers,
        // Releasing this body is reading those events to the end: they are one reader over one
        // connection, and a second reader is not something a `ReadableStream` allows.
        'response.http.body': exchange.body,
        'response.usage.billable': providerUsage(candidate, back, called),
      });
    }

    spentBody(exchange.body);
    const body = await readUpstreamBody(result.response);
    if (!('json' in body)) {
      // Every protocol the gateway carries is one it fully understands, so a body it cannot
      // read is not handed on unread.
      const essence = mediaTypeEssence(mediaType) ?? 'no media type';
      await use.log.warn('upstream answered with a body that is not JSON', { status: result.response.status, mediaType: essence });
      return read({
        status: 502,
        message: `The upstream answered ${result.response.status} with ${essence}, and the OpenAI Images protocol is JSON.`,
        body: body.text,
      }, called);
    }

    let canonical: CanonicalOpenAIImagesResponse;
    try {
      canonical = parseOpenAIImagesResponse(body.json);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await use.log.warn('upstream answered with a body the OpenAI Images protocol cannot read', { message });
      return read({ status: 502, message, body: body.json }, called);
    }
    return read(canonical, wasCalled ? [{ identity, quantities: billed(canonical.usage) }] : []);
  },
});

interface MeteredFrames {
  readonly frames: OpenAIImagesFrames;
  readonly outcome: Deferred<StreamOutcome>;
}

const meterFrames = (
  body: ReadableStream<Uint8Array>,
  identity: TelemetryModelIdentity,
  signal: AbortSignal | undefined,
): MeteredFrames => {
  const settlement = Promise.withResolvers<StreamOutcome>();
  // Declared as this run's own unfinished work, so the runner waits for it at teardown where
  // it can see it rather than the reading being started and forgotten.
  const outcome = defer(settlement.promise);
  // Running out without the completed event is what "it did not finish" means, and it is known
  // at the same moment the usage is.
  let sawTerminal = false;
  const frames = retainReader((async function* () {
    let usage: CanonicalOpenAIImagesUsage | undefined;
    try {
      for await (const event of parseOpenAIImagesStream(body, { signal })) {
        if (isOpenAIImagesTerminalEvent(event)) {
          usage = parseOpenAIImagesUsage(event);
          sawTerminal = true;
          yield event;
          // The image is complete, so there is nothing further to read. An upstream that holds
          // the connection open past this point would otherwise keep the client's own stream
          // open with it; returning here closes the read, which cancels the upstream.
          return;
        }
        yield event;
      }
    } finally {
      // Reached however the events ended — the completed one, a client that stopped reading,
      // or a broken upstream — because what the upstream already metered is billable whatever
      // happened to the downstream half.
      try {
        settlement.resolve({ billable: [{ identity, quantities: billed(usage) }], failed: !sawTerminal });
      } catch (error) {
        settlement.reject(error);
        throw error;
      }
    }
    // Only an upstream that ended its body without ever completing the image reaches here: the
    // arm above returns on the terminal event. A client has been sent partial images and no
    // image, which is a failed answer however far it got.
    throw new Error(OPENAI_IMAGES_MISSING_TERMINAL_MESSAGE);
  })());
  return { frames, outcome };
};

/** An image is billed by the tokens its upstream reports: `BILLING_METRICS` names no per-image
 *  or per-size unit, and per-size pricing is a selector coordinate rather than a metric, so
 *  there is nothing else here to record a count against. A reported zero is kept — it says the
 *  upstream reported, which an absent metric would not. */
const billed = (usage: CanonicalOpenAIImagesUsage | undefined): UsageQuantities => {
  const quantities: UsageQuantities = {};
  if (usage?.inputTokens !== undefined) quantities.input_tokens = parseDecimalString(String(usage.inputTokens));
  if (usage?.inputImageTokens !== undefined) quantities.input_image_tokens = parseDecimalString(String(usage.inputImageTokens));
  if (usage?.outputTokens !== undefined) quantities.output_tokens = parseDecimalString(String(usage.outputTokens));
  if (usage?.outputImageTokens !== undefined) quantities.output_image_tokens = parseDecimalString(String(usage.outputImageTokens));
  return quantities;
};

/** The provider's own shape, built where the dial happens. What it needs from a reference is
 *  whether the data URL inside it can become a file, because that decides whether the edit can
 *  ride as a multipart form; the canonical fact holds the reference the client wrote and leaves
 *  that question to the serializer that has it. */
const providerEditsRequest = (request: CanonicalOpenAIImagesEditsRequest): OpenAIImagesEditsRequest => ({
  images: request.images.map(providerEditsSource),
  ...(request.mask === undefined ? {} : { mask: providerEditsSource(request.mask) }),
  parameters: request.parameters,
});

const providerEditsSource = (image: OpenAIImagesEditImage): OpenAIImagesEditsSource => {
  if (image.kind === 'file') {
    return { type: 'upload', file: { bytes: image.file.bytes, name: image.file.fileName, type: image.file.mediaType } };
  }
  const { reference } = image;
  return typeof reference.image_url === 'string' && isBase64ImageDataUrl(reference.image_url)
    ? { type: 'inline', reference: reference as OpenAIImageEditReference & { image_url: string } }
    : { type: 'reference', reference };
};
