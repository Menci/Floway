import type { Fields, OpenAIAudioTranscriptionEvents, OpenAIAudioTranscriptionStreamOutcome } from './facts.ts';
import type { UsageQuantities } from '../../repo/types.ts';
import type { BillableEntity, Failure } from '../pipeline/facts.ts';
import { providerEntry } from '../pipeline/provider-entry.ts';
import { providerUsage } from '../pipeline/provider-usage.ts';
import type { GatewayServices } from '../pipeline/services.ts';
import { dialFailure, spentBody, retainReader } from '../pipeline/upstream-body.ts';
import { upstreamPerformanceContext, telemetryModelIdentity } from '../shared/telemetry/attribution.ts';
import { recordStream } from '@floway-dev/dump';
import { exchangeResponse } from '@floway-dev/http/pipeline';
import { defineStage, move, setRelease, defer, type Owned, type Logger, type Deferred } from '@floway-dev/pipeline';
import { isEventStreamMediaType, eventFrame, parseSSEStream, parseDecimalString } from '@floway-dev/protocols/common';
import { parseOpenAIAudioTranscription, parseOpenAIAudioTranscriptionUsage, isOpenAIAudioTranscriptionDoneEvent, parseOpenAIAudioTranscriptionStreamUsage, type OpenAIAudioTranscriptionResponseFormat, type CanonicalOpenAIAudioTranscription, type OpenAIAudioTranscriptionUsage } from '@floway-dev/protocols/openai-audio';
import type { ProviderRequest, ProviderOperationPayloads, ProviderResponse, TelemetryModelIdentity } from '@floway-dev/provider';

/**
 * The ending. It dials, reads what came back in the rendering the request asked for, and
 * provides the answer, the raw HTTP response beneath it, and what the call is billable for.
 * A failure is a value: a 429 here is what an earlier stage fails over, and so is a dial that
 * never reached anyone. A 200 is never one of them — this endpoint carries the document the
 * upstream sent rather than serializing one from what it read, so a body no reading could
 * open is still that upstream's answer and there is nothing to try the next candidate for.
 */
export const callOpenAIAudioTranscriptionUpstream = defineStage<
  Fields<'ingress.openaiAudioTranscription.responseFormat' | 'request.openaiAudioTranscription.form' | 'route.attempt' | 'ingress.http.headers'>,
  ProviderRequest<ProviderOperationPayloads['openaiAudioTranscriptions']>,
  ProviderResponse,
  Fields<'response.openaiAudioTranscription.canonical' | 'response.openaiAudioTranscription.mediaType' | 'response.openaiAudioTranscription.streamedOutcome'>
    & { 'response.usage.billable': readonly BillableEntity[]; 'response.http.status': number;
      'response.http.headers': readonly (readonly [string, string])[];
      'response.http.body': (ReadableStream<Uint8Array> & Owned) | null; },
  GatewayServices
>({
  name: 'callOpenAIAudioTranscriptionUpstream',
  into: {
    request: { needs: ['ingress.openaiAudioTranscription.responseFormat', 'request.openaiAudioTranscription.form', 'route.attempt', 'ingress.http.headers'], consumes: [], provides: ['request.provider.model', 'request.provider.payload', 'request.http.callId', 'request.http.headers'] },
    response: { needs: ['response.http.exchange', 'response.provider.modelKey', 'response.provider.called', 'response.provider.previousCalls', 'response.http.body'], consumes: ['response.http.exchange', 'response.provider.modelKey', 'response.provider.called', 'response.provider.previousCalls'], provides: ['response.openaiAudioTranscription.canonical', 'response.openaiAudioTranscription.mediaType', 'response.openaiAudioTranscription.streamedOutcome', 'response.usage.billable', 'response.http.status', 'response.http.headers', 'response.http.body'] },
  },
  execute: async (facts, next, use) => {
    const candidate = use.resolveAttempt(facts['route.attempt']);
    // Attribution is set before the dial, so an attempt that never completes still names the
    // candidate it was made against rather than the one tried before it.
    use.gateway.attempt.telemetry = upstreamPerformanceContext(use.gateway, candidate, 'audio_transcription');

    const pipeline = candidate.provider.pipelines.openaiAudioTranscriptions;
    if (pipeline === undefined) throw new Error(`Provider ${candidate.provider.kind} has no openaiAudioTranscriptions pipeline`);
    const back = await next(providerEntry(facts, candidate, { entries: facts['request.openaiAudioTranscription.form'] }), pipeline);
    const { 'response.http.exchange': exchange, 'response.provider.modelKey': modelKey, 'response.provider.called': wasCalled, 'response.provider.previousCalls': _previousCalls, ...rest } = back;
    if (exchange.type === 'transportFailure') {
      return move({
        ...rest,
        'response.openaiAudioTranscription.canonical': dialFailure(exchange.error),
        'response.openaiAudioTranscription.mediaType': null,
        'response.openaiAudioTranscription.streamedOutcome': null,
        'response.usage.billable': providerUsage(candidate, back, []),
        'response.http.status': 502,
        'response.http.headers': [],
        'response.http.body': spentBody(null),
      });
    }
    const result = { response: exchangeResponse(exchange), modelKey };

    const identity = telemetryModelIdentity(candidate, result.modelKey);
    const format = facts['ingress.openaiAudioTranscription.responseFormat'];
    const status = result.response.status;
    const mediaType = result.response.headers.get('content-type');
    const headers = move([...result.response.headers] as readonly (readonly [string, string])[]);
    // An upstream that was called and reported nothing is a different situation from one
    // that reported zero, so the entity is present with no quantities.
    const called: readonly BillableEntity[] = wasCalled ? [{ identity, quantities: {} }] : [];

    if (!result.response.ok) {
      await use.log.warn('upstream refused', { status });
      spentBody(exchange.body);
      // An upstream error body is JSON like any other body, and reading it here is also what
      // leaves a losing attempt with nothing open behind it.
      return move({
        ...rest,
        'response.openaiAudioTranscription.canonical': await refusal(status, result.response),
        'response.openaiAudioTranscription.mediaType': mediaType,
        'response.openaiAudioTranscription.streamedOutcome': null,
        'response.usage.billable': providerUsage(candidate, back, called),
        'response.http.status': status,
        'response.http.headers': headers,
        'response.http.body': spentBody(exchange.body),
      });
    }

    // A streamed answer is the one the client asked for with `stream`, and it is the media
    // type that says one arrived: an upstream that ignores `stream` — `whisper-1` does —
    // answers in the rendering `response_format` named instead.
    // https://github.com/openai/openai-openapi/blob/db3e53198a66732cfe161339ea63bf36fc0137ad/openapi.yaml#L36325-L36336
    if (isEventStreamMediaType(mediaType)) {
      if (result.response.body === null) {
        return move({
          ...rest,
          'response.openaiAudioTranscription.canonical': { status: 502, message: 'Upstream returned a streaming response with no body.' },
          'response.openaiAudioTranscription.mediaType': mediaType,
          'response.openaiAudioTranscription.streamedOutcome': null,
          'response.usage.billable': providerUsage(candidate, back, called),
          'response.http.status': status,
          'response.http.headers': headers,
          'response.http.body': spentBody(null),
        });
      }
      // What the upstream metered, and whether the transcript finished, are both observed
      // here — closest to the upstream and on the protocol it spoke — by folding the events
      // as they pass, so the reading costs one pass and the client's own stream drives it.
      const metered = meterEvents(result.response.body, identity, use.gateway.abortSignal, use.log);
      setRelease(exchange.body!, async () => { for await (const _event of metered.events) { /* drain */ } });
      return move({
        ...rest,
        // SSE labels and data remain upstream-owned; parsing below only observes billing and completion.
        'response.openaiAudioTranscription.canonical': recordStream(metered.events, use.gateway.dump, eventFrame),
        'response.openaiAudioTranscription.mediaType': mediaType,
        'response.openaiAudioTranscription.streamedOutcome': defer(metered.outcome.then(outcome => ({ ...outcome, billable: providerUsage(candidate, back, outcome.billable) }))),
        'response.usage.billable': providerUsage(candidate, back, called),
        'response.http.status': status,
        'response.http.headers': headers,
        // Releasing this body is reading those events to the end: they are one reader over
        // one connection, and a second reader is not something a `ReadableStream` allows.
        'response.http.body': exchange.body,
      });
    }

    // A 2xx body is the answer whether or not this endpoint could read it, because what the
    // client is sent is the document that arrived and not something serialized from a parse.
    // So there is nothing here to fail over from: the reading feeds the record and the usage
    // row, and the bytes travel either way.
    spentBody(exchange.body);
    const read = await readTranscription(format, new Uint8Array(await result.response.arrayBuffer()), use.log);
    return move({
      ...rest,
      'response.openaiAudioTranscription.canonical': read.canonical,
      'response.openaiAudioTranscription.mediaType': mediaType,
      'response.openaiAudioTranscription.streamedOutcome': null,
      'response.usage.billable': providerUsage(candidate, back, wasCalled ? [{ identity, quantities: billed(read.usage) }] : []),
      'response.http.status': status,
      'response.http.headers': headers,
      'response.http.body': spentBody(exchange.body),
    });
  },
});

const refusal = async (status: number, response: Response): Promise<Failure> => {
  const text = await response.text();
  try {
    return { status, message: text, body: JSON.parse(text) as unknown };
  } catch {
    // A refusal that is not JSON is still a refusal, and its text is what the client is
    // told; there is simply no parsed body for a dump reader to open.
    return { status, message: text };
  }
};

/**
 * What a 2xx body was worth to this endpoint, in two readings that do not depend on each
 * other.
 *
 * Neither can cost the client the answer: the document is carried, so a body no reading
 * could open is still what goes back, and what a failed reading costs is the transcript in
 * the record and whatever usage the body would have stated. Nor can either cost the other —
 * an upstream whose usage block this gateway cannot model still had its transcript read, and
 * one whose document it could not open is still billed for nothing rather than mis-billed.
 */
const readTranscription = async (
  format: OpenAIAudioTranscriptionResponseFormat,
  document: Uint8Array,
  log: Logger,
): Promise<{ readonly canonical: CanonicalOpenAIAudioTranscription; readonly usage: OpenAIAudioTranscriptionUsage | undefined }> => {
  let canonical: CanonicalOpenAIAudioTranscription;
  try {
    canonical = parseOpenAIAudioTranscription(format, document);
  } catch (error) {
    await log.warn('failed to parse 2xx upstream body for /audio/transcriptions; forwarding it as it arrived', { error });
    return { canonical: { document }, usage: undefined };
  }
  // Only an object rendering states usage: `text`, `srt` and `vtt` have nowhere to put it,
  // and asking them for one is what would warn about every subtitle a client requests.
  return { canonical, usage: canonical.raw === undefined ? undefined : await readUsage(() => parseOpenAIAudioTranscriptionUsage(canonical.raw), log) };
};

/** A transcription states its usage in two places — the body of an object rendering and the
 *  terminal event of a stream — and either can state it in a shape this gateway cannot read.
 *  That upstream metered something, and the request is recorded saying exactly that: the
 *  entity, and no quantities. */
const readUsage = async (read: () => OpenAIAudioTranscriptionUsage | undefined, log: Logger): Promise<OpenAIAudioTranscriptionUsage | undefined> => {
  try {
    return read();
  } catch (error) {
    await log.warn('invalid usage in 2xx upstream response; recording the request only', { error });
    return undefined;
  }
};

interface MeteredEvents {
  readonly events: OpenAIAudioTranscriptionEvents;
  readonly outcome: Deferred<OpenAIAudioTranscriptionStreamOutcome>;
}

const meterEvents = (
  body: ReadableStream<Uint8Array>,
  identity: TelemetryModelIdentity,
  signal: AbortSignal | undefined,
  log: Logger,
): MeteredEvents => {
  let settle!: (outcome: OpenAIAudioTranscriptionStreamOutcome) => void;
  // Declared as this run's own unfinished work, so the runner waits for it at teardown where
  // it can see it rather than the reading being started and forgotten.
  const outcome = defer(new Promise<OpenAIAudioTranscriptionStreamOutcome>(resolve => { settle = resolve; }));
  const events = retainReader((async function* () {
    let usage: OpenAIAudioTranscriptionUsage | undefined;
    let completed = false;
    try {
      for await (const frame of parseSSEStream(body, { signal })) {
        const event: unknown = JSON.parse(frame.data);
        if (isOpenAIAudioTranscriptionDoneEvent(event)) {
          usage = await readUsage(() => parseOpenAIAudioTranscriptionStreamUsage(event), log);
          completed = true;
          yield frame;
          // The transcript is complete, so there is nothing further to read. An upstream that
          // holds the connection open past this point would otherwise keep the client's own
          // stream open with it; returning here closes the read, which cancels the upstream.
          return;
        }
        yield frame;
      }
    } finally {
      // Reached however the events ended — the terminal one, a client that stopped reading,
      // or a broken upstream — because what the upstream already metered is billable
      // whatever happened to the downstream half.
      settle({ billable: [{ identity, quantities: billed(usage) }], failed: !completed });
    }
  })());
  return { events, outcome };
};

const billed = (usage: OpenAIAudioTranscriptionUsage | undefined): UsageQuantities => {
  if (usage === undefined) return {};
  if (usage.kind === 'duration') return { input_audio_seconds: parseDecimalString(String(usage.seconds)) };
  // Audio input is priced apart from text input, so what stays on the general input metric is
  // what the upstream did not attribute to audio.
  return {
    input_tokens: parseDecimalString(String(usage.inputTokens - (usage.inputAudioTokens ?? 0))),
    ...(usage.inputAudioTokens === undefined ? {} : { input_audio_tokens: parseDecimalString(String(usage.inputAudioTokens)) }),
    output_tokens: parseDecimalString(String(usage.outputTokens)),
  };
};
