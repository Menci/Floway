export const mapReadableFailure = (
  source: ReadableStream<Uint8Array>,
  map: (cause: unknown) => unknown,
): ReadableStream<Uint8Array> => {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let cancelled = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const current = reader ??= source.getReader();
      let item: ReadableStreamReadResult<Uint8Array>;
      try {
        item = await current.read();
      } catch (cause) {
        if (cancelled) return;
        current.releaseLock();
        throw map(cause);
      }
      if (cancelled) return;
      if (item.done) {
        current.releaseLock();
        controller.close();
      } else {
        controller.enqueue(item.value);
      }
    },
    async cancel(reason) {
      cancelled = true;
      if (reader === undefined) {
        await source.cancel(reason);
        return;
      }
      try {
        await reader.cancel(reason);
      } finally {
        reader.releaseLock();
      }
    },
  }, { highWaterMark: 0 });
};

export const trackReadableFailure = (source: ReadableStream<Uint8Array>) => {
  if (source.locked) throw new TypeError('The readable stream is locked');
  let failure: { cause: unknown } | undefined;
  const body = mapReadableFailure(source, cause => {
    failure = { cause };
    return cause;
  });
  return { body, get failure() { return failure; } };
};
