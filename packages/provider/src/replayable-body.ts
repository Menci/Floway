const STREAM_CHUNK_BYTES = 64 * 1024;

export interface ReplayableBodySource {
  // Segments are borrowed until the fetch settles. The array shape is frozen,
  // but callers that own a Uint8Array must not mutate its bytes in flight.
  readonly segments: readonly Uint8Array[];
  readonly byteLength: number;
}

const sources = new WeakMap<ReadableStream<Uint8Array>, ReplayableBodySource>();

const assertSource = (segments: readonly Uint8Array[]): ReplayableBodySource => {
  let byteLength = 0;
  for (const segment of segments) {
    byteLength += segment.byteLength;
    if (!Number.isSafeInteger(byteLength)) throw new RangeError('Replayable body byte length exceeds Number.MAX_SAFE_INTEGER');
  }
  return Object.freeze({ segments: Object.freeze([...segments]), byteLength });
};

export const replayableBodyStream = (source: ReplayableBodySource): ReadableStream<Uint8Array> => {
  let segmentIndex = 0;
  let segmentOffset = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      while (segmentIndex < source.segments.length) {
        const segment = source.segments[segmentIndex]!;
        if (segmentOffset >= segment.byteLength) {
          segmentIndex += 1;
          segmentOffset = 0;
          continue;
        }
        const end = Math.min(segment.byteLength, segmentOffset + STREAM_CHUNK_BYTES);
        controller.enqueue(segment.subarray(segmentOffset, end));
        segmentOffset = end;
        return;
      }
      controller.close();
    },
  }, { highWaterMark: 0 });
  sources.set(stream, source);
  return stream;
};

export const createReplayableBody = (segments: readonly Uint8Array[]): ReadableStream<Uint8Array> =>
  replayableBodyStream(assertSource(segments));

export const replayableBodySource = (body: BodyInit | null | undefined): ReplayableBodySource | null =>
  body instanceof ReadableStream ? sources.get(body) ?? null : null;

type DuplexRequestInit = RequestInit & { duplex: 'half' };

export const nativeFetchInit = (init: RequestInit): RequestInit => {
  if (!(init.body instanceof ReadableStream)) return init;
  const source = replayableBodySource(init.body);
  const headers = new Headers(init.headers);
  if (source !== null) headers.set('content-length', String(source.byteLength));
  return {
    ...init,
    body: source === null ? init.body : replayableBodyStream(source),
    headers,
    duplex: 'half',
  } as DuplexRequestInit;
};
