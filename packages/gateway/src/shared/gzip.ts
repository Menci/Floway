// gzip helpers built on the web-standard compression streams, so the same code
// runs on both deployment targets.
//
// The source stream is assembled by hand rather than taken from
// `new Blob([bytes]).stream()`: a Blob is a Node `BaseObject` registered in the
// realm's `BaseObjectList`, which is a GC root, and `Blob.prototype.stream()`
// leaves the source buffer attached to it. Nothing ever collects it, and
// because the bytes are native the retention is invisible in `heapUsed` — a
// gateway storing OpenAI Responses payloads leaked one full copy of every payload it
// compressed, and only RSS showed it. Feeding the transform from a plain
// `ReadableStream` keeps the pipeline identical and allocates no Blob.
// https://github.com/nodejs/node/issues/63574
// https://github.com/nodejs/node/issues/64105
// The chunk type is `BufferSource` rather than `Uint8Array` to match what
// CompressionStream's writable half declares, so `pipeThrough` lines up without
// a cast. The enqueue itself is cast because `BufferSource` narrows to views
// over a plain `ArrayBuffer`, while callers hand us the default
// `Uint8Array<ArrayBufferLike>`; both runtimes accept any view here, and the
// alternative — copying through `new Uint8Array(bytes)` to satisfy the lib
// type — would allocate a second full copy of every payload we compress.
const bytesStream = (bytes: Uint8Array): ReadableStream<BufferSource> =>
  new ReadableStream<BufferSource>({
    start(controller) {
      controller.enqueue(bytes as BufferSource);
      controller.close();
    },
  });

const collect = async (stream: ReadableStream): Promise<Uint8Array> =>
  new Uint8Array(await new Response(stream).arrayBuffer());

export const gzipBytes = async (bytes: Uint8Array): Promise<Uint8Array> =>
  await collect(bytesStream(bytes).pipeThrough(new CompressionStream('gzip')));

export const gunzipBytes = async (bytes: Uint8Array): Promise<Uint8Array> =>
  await collect(bytesStream(bytes).pipeThrough(new DecompressionStream('gzip')));

export const gzipStream = (stream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> =>
  transformStream(stream, new CompressionStream('gzip'));

export const gunzipStream = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
  transformStream(bytesStream(bytes), new DecompressionStream('gzip'));

const transformStream = (
  source: ReadableStream<Uint8Array | BufferSource>,
  transform: CompressionStream | DecompressionStream,
): ReadableStream<Uint8Array> => {
  const reader = source.getReader();
  const writer = transform.writable.getWriter();
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        await writer.write(value as BufferSource);
      }
      await writer.close();
    } catch (error) {
      try {
        await writer.abort(error);
      } catch {
        // The transform may already be closed by the same source error.
      }
      try {
        await reader.cancel(error);
      } catch {
        // The upstream reader may already be closed by the same source error.
      }
    }
  })();
  return transform.readable as ReadableStream<Uint8Array>;
};
