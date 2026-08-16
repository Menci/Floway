// Images as a pipeline. Two endpoints and one family: `generations` sends JSON and `edits`
// sends either JSON or a multipart form, so what the operation decides is the request fact and
// the provider method the ending calls, and the four stages are the same either way.
//
//   emitImages            the edge: serializes the answer into the images protocol
//   resolveCandidates     narrows to the upstreams that expose this operation's endpoint
//   failover              runs what follows once per candidate
//   callImagesUpstream    the ending: dials, and provides what came back

import type { UsageQuantities } from '../../repo/types.ts';
import type { Failure, GatewayFacts } from '../pipeline/facts.ts';
import { isFailure } from '../pipeline/facts.ts';
import type { GatewayServices } from '../pipeline/services.ts';
import { failover, resolveCandidates } from '../pipeline/stages.ts';
import { telemetryModelIdentity, upstreamPerformanceContext } from '../shared/telemetry/attribution.ts';
import { buildUpstreamCallOptions } from '../shared/upstream-call-options.ts';
import { isForwardableUpstreamHeader } from '../shared/upstream-response.ts';
import type { Pipeline } from '@floway-dev/pipeline';
import { compose, defineStage, move } from '@floway-dev/pipeline';
import { mediaTypeEssence, parseDecimalString, type ModelEndpointKey } from '@floway-dev/protocols/common';
import {
  imagesErrorMessage,
  parseImagesResponse,
  renderImagesError,
  renderImagesResponse,
  type CanonicalImagesEditsRequest,
  type CanonicalImagesRequest,
  type CanonicalImagesResponse,
  type CanonicalImagesUsage,
  type ImageEditReference,
  type ImagesEditImage,
  type ImagesOperation,
} from '@floway-dev/protocols/images';
import { isBase64ImageDataUrl, providerModelOf } from '@floway-dev/provider';
import type { ImagesEditsRequest, ImagesEditsSource, ModelCandidate, PerformanceOperation } from '@floway-dev/provider';

/** Images' own keys. They extend the shared space and never merge into it, so a stage written
 *  against the gateway alone cannot name one. */
export interface ImagesFacts extends GatewayFacts {
  'request.images.canonical': CanonicalImagesRequest;
  'response.images.canonical': CanonicalImagesResponse | Failure;
  /** What the client is actually sent, in the images protocol. The edge provides it, so a dump
   *  shows the body the client received rather than the gateway's canonical form. */
  'response.images.rendered': Record<string, unknown>;
}

type I<K extends keyof ImagesFacts> = { [P in K]: ImagesFacts[P] };

const ENDPOINT = {
  generations: 'imagesGenerations',
  edits: 'imagesEdits',
} as const satisfies Record<ImagesOperation, ModelEndpointKey>;

const PERFORMANCE_OPERATION = {
  generations: 'image_generation',
  edits: 'image_edit',
} as const satisfies Record<ImagesOperation, PerformanceOperation>;

/**
 * The outermost edge. It names nothing on the way down — the family has one protocol, so there
 * is no request to read to know how to answer — and coming back it renders the answer, keeps
 * the upstream headers a client may see, and decides the status. The status is decided here
 * rather than carried up because a refusal that never reached an upstream has none to carry.
 */
const emitImages = defineStage<
  Record<string, never>,
  Record<string, never>,
  I<'response.images.canonical' | 'response.http.headers'>,
  I<'response.images.rendered' | 'response.http.status' | 'response.http.headers'>
>({
  name: 'emitImages',
  through: {
    request: { needs: [], consumes: [], provides: [] },
    response: {
      needs: ['response.images.canonical', 'response.http.headers'],
      consumes: ['response.images.canonical', 'response.http.headers'],
      provides: ['response.images.rendered', 'response.http.status', 'response.http.headers'],
    },
  },
  execute: async (facts, next) => {
    const back = await next(facts);
    const { 'response.images.canonical': answer, 'response.http.headers': headers, ...rest } = back;
    // Vendor traces and quota state stay visible; what an intermediary must strip, and what
    // would misdescribe a body this gateway serialized itself, does not. A filter that removed
    // nothing hands the same array on, so the record shows no change where none happened.
    const forwardable = headers.filter(([name]) => isForwardableUpstreamHeader(name));
    const forClient = forwardable.length === headers.length ? headers : move(forwardable);
    if (isFailure(answer)) {
      return {
        ...rest,
        'response.http.headers': forClient,
        'response.images.rendered': move(renderImagesError(answer.message, answer.body)),
        'response.http.status': answer.status,
      };
    }
    return {
      ...rest,
      'response.http.headers': forClient,
      'response.images.rendered': move(renderImagesResponse(answer)),
      'response.http.status': 200,
    };
  },
});

/**
 * The ending. It dials, reads the upstream's body, and provides the canonical answer, the
 * headers that came with it, and what the call is billable for. A failure is a value: an
 * upstream that refused, and one that answered with something this protocol cannot read, are
 * both outcomes the fork above can take to the next candidate rather than faults that end the
 * run.
 */
const callImagesUpstream = defineStage<
  I<'request.images.canonical' | 'route.candidate' | 'ingress.http.headers'>,
  I<'response.images.canonical' | 'response.http.headers' | 'response.usage.billable'>,
  GatewayServices
>({
  name: 'callImagesUpstream',
  return: {
    provides: ['response.images.canonical', 'response.http.headers', 'response.usage.billable'],
  },
  execute: async (facts, use) => {
    const candidate = facts['route.candidate'];
    const request = facts['request.images.canonical'];
    const options = buildUpstreamCallOptions(
      candidate,
      use.gateway,
      // The client's own headers reach the upstream from the record, not from a live request
      // object: what a provider is allowed to forward is filtered per provider, and the dump
      // shows what was there to filter.
      new Headers(facts['ingress.http.headers'].map(([name, value]) => [name, value])),
    );
    const model = providerModelOf(candidate);
    // No abort signal, as on this family's endpoints from the beginning: an image the upstream
    // has already begun is charged for whether or not the client waited for it, so dropping the
    // call would lose the usage reading and save nothing.
    const result = request.operation === 'generations'
      ? await candidate.provider.instance.callImagesGenerations(model, request.parameters, undefined, options)
      : await candidate.provider.instance.callImagesEdits(model, providerEditsRequest(request), undefined, options);
    use.gateway.attempt.telemetry = upstreamPerformanceContext(use.gateway, candidate, PERFORMANCE_OPERATION[request.operation]);
    const identity = telemetryModelIdentity(candidate, result.modelKey);
    // What came back, unfiltered: the edge is where a client's view of it is decided.
    const headers = [...result.response.headers];
    const answered = (canonical: CanonicalImagesResponse | Failure, quantities: UsageQuantities) => move({
      ...facts,
      'response.images.canonical': canonical,
      'response.http.headers': headers,
      'response.usage.billable': [{ identity, quantities }],
    });
    // An entity with no quantities is how "the upstream was called and reported nothing" is
    // said, which is a different situation from reporting zero.
    const reportedNothing: UsageQuantities = {};

    const body = await readUpstreamBody(result.response);
    if (!result.response.ok) {
      use.log.warn('upstream refused', { status: result.response.status });
      return answered({
        status: result.response.status,
        message: imagesErrorMessage(body.json) ?? body.text,
        ...('json' in body ? { body: body.json } : {}),
      }, reportedNothing);
    }
    if (!('json' in body)) {
      // Every protocol the gateway carries is one it fully understands, so a body it cannot
      // read is not handed on unread. A client that asked for `stream: true` lands here: the
      // images stream is not carried as facts yet.
      const mediaType = mediaTypeEssence(result.response.headers.get('content-type')) ?? 'no media type';
      use.log.warn('upstream answered with a body that is not JSON', { status: result.response.status, mediaType });
      return answered({
        status: 502,
        message: `The upstream answered ${result.response.status} with ${mediaType}, and the images protocol is JSON.`,
        body: body.text,
      }, reportedNothing);
    }

    let canonical: CanonicalImagesResponse;
    try {
      canonical = parseImagesResponse(body.json);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      use.log.warn('upstream answered with a body the images protocol cannot read', { message });
      return answered({ status: 502, message, body: body.json }, reportedNothing);
    }
    return answered(canonical, billed(canonical.usage));
  },
});

interface UpstreamBody {
  readonly text: string;
  /** Absent when the body was not JSON at all, which is itself the answer to a protocol that
   *  requires JSON. */
  readonly json?: unknown;
}

const readUpstreamBody = async (response: Response): Promise<UpstreamBody> => {
  const text = await response.text();
  try {
    return { text, json: JSON.parse(text) as unknown };
  } catch {
    return { text };
  }
};

/** An image is billed by the tokens its upstream reports: `BILLING_METRICS` names no per-image
 *  or per-size unit, and per-size pricing is a selector coordinate rather than a metric, so
 *  there is nothing else here to record a count against. A reported zero is kept — it says the
 *  upstream reported, which an absent metric would not. */
const billed = (usage: CanonicalImagesUsage | undefined): UsageQuantities => {
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
const providerEditsRequest = (request: CanonicalImagesEditsRequest): ImagesEditsRequest => ({
  images: request.images.map(providerEditsSource),
  ...(request.mask === undefined ? {} : { mask: providerEditsSource(request.mask) }),
  parameters: request.parameters,
});

const providerEditsSource = (image: ImagesEditImage): ImagesEditsSource => {
  if (image.kind === 'file') {
    return { type: 'upload', file: new File([image.file.bytes], image.file.fileName, { type: image.file.mediaType }) };
  }
  const { reference } = image;
  return typeof reference.image_url === 'string' && isBase64ImageDataUrl(reference.image_url)
    ? { type: 'inline', reference: reference as ImageEditReference & { image_url: string } }
    : { type: 'reference', reference };
};

/** A candidate that cannot serve *this* request is not a candidate. One family covers two
 *  endpoints and an upstream may expose either without the other, so which one is asked for is
 *  what narrows the list. A refusal answers with no upstream headers because there was no
 *  upstream, which is the same statement the edge above reads on every other path. */
const narrowing = (request: CanonicalImagesRequest) => ({
  kind: 'image' as const,
  reject: (candidate: ModelCandidate) => candidate.model.endpoints[ENDPOINT[request.operation]] === undefined
    ? `the upstream does not expose the images ${request.operation} endpoint`
    : null,
  refuse: (status: number, message: string) => ({
    'response.images.canonical': { status, message },
    'response.http.headers': [],
  }),
  refuses: ['response.images.canonical', 'response.http.headers'] as const,
});

/** What a caller must bring. `ingress.http.headers` and `request.images.canonical` are in it
 *  although `compose` cannot derive them — the ending stage reads both and a return-only stage
 *  declares no request side — so this type is the whole statement and `entryNeeds` is part of
 *  it. */
export type ImagesServeEntry = I<'ingress.http.headers' | 'request.images.canonical' | 'serve.model'>;

export type ImagesServeExit = I<'response.images.rendered' | 'response.http.status' | 'response.http.headers' | 'response.usage.billable'>;

export const imagesServePipeline = (request: CanonicalImagesRequest): Pipeline<ImagesServeEntry, ImagesServeExit> =>
  compose('imagesServe', [
    emitImages,
    resolveCandidates(narrowing(request)),
    failover({
      failed: handedUp => isFailure((handedUp as { 'response.images.canonical'?: unknown })['response.images.canonical']),
      owns: [],
    }),
    callImagesUpstream,
  ]);
