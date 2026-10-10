// Read independently until the measurement boundary, then restore ordinary
// downstream backpressure. A full-stream tee would retain an unbounded response
// when the client stalls. The prefix has both an object-count and payload bound.
// https://developers.cloudflare.com/workers/runtime-apis/streams/
export const observeStreamPrefix = <T>(
  events: AsyncIterable<T>,
  observe: (value: T) => boolean,
  onLimit: () => void,
  onFinish: () => void,
  cancelPendingRead: () => void,
): AsyncIterableIterator<T> => {
  const source = events[Symbol.asyncIterator]();
  const queue: { value: T; codeUnits: number }[] = [];
  let activeNext = Promise.resolve();
  let finished = false;
  const finish = (): void => {
    if (finished) return;
    finished = true;
    onFinish();
  };
  let readPending = false;
  const pull = async (): Promise<IteratorResult<T>> => {
    readPending = true;
    try { return await source.next(); } finally { readPending = false; }
  };
  const cancelRead = (): void => { if (readPending) cancelPendingRead(); };
  let retainedCodeUnits = 0;
  let stopped = false;
  let closed = false;
  let failure: { error: unknown } | undefined;
  let notify = (): void => {};
  const read = async (): Promise<IteratorResult<T>> => {
    try {
      const result = await pull();
      if (result.done) {
        closed = true;
        finish();
      } else if (!closed) {
        observe(result.value);
      } else {
        return { done: true, value: undefined };
      }
      return result;
    } catch (error) {
      closed = true;
      cancelRead();
      try {
        await source.return?.();
      } catch (cleanupError) {
        console.error('Floway: upstream observation cleanup failed', cleanupError);
      }
      finish();
      throw error;
    }
  };
  const prefix = (async () => {
    try {
      while (!closed && !stopped) {
        // Observe before retaining the frame so the timestamp excludes local
        // serialization and queue management as well as downstream writes.
        const result = await pull();
        if (closed) break;
        if (result.done) {
          closed = true;
          finish();
          break;
        }
        const boundary = observe(result.value);
        const codeUnits = boundary ? 0 : JSON.stringify(result.value).length;
        queue.push({ value: result.value, codeUnits });
        retainedCodeUnits += codeUnits;
        if (boundary) stopped = true;
        else if (queue.length >= 256 || retainedCodeUnits >= 512 * 1024) {
          stopped = true;
          onLimit();
        }
        notify();
      }
    } catch (error) {
      failure = { error };
      closed = true;
      cancelRead();
      try {
        await source.return?.();
      } catch (cleanupError) {
        console.error('Floway: upstream prefix cleanup failed', cleanupError);
      }
      finish();
    } finally {
      stopped = true;
      notify();
    }
  })();
  return {
    [Symbol.asyncIterator]() { return this; },
    next() {
      const pending = activeNext.then(async (): Promise<IteratorResult<T>> => {
        while (queue.length === 0 && !stopped) {
          await new Promise<void>(resolve => { notify = resolve; });
        }
        if (queue.length !== 0) {
          const { value, codeUnits } = queue.shift()!;
          retainedCodeUnits -= codeUnits;
          return { done: false, value };
        }
        await prefix;
        if (failure !== undefined) throw failure.error;
        if (closed) return { done: true, value: undefined };
        return await read();
      });
      activeNext = pending.then(() => {}, () => {});
      return pending;
    },
    async return() {
      closed = true;
      stopped = true;
      queue.length = 0;
      notify();
      try {
        // Async-generator return is queued behind a pending next. Cancel the
        // transport first so a stalled upstream read can actually complete.
        cancelRead();
        await source.return?.();
        await prefix;
        if (failure !== undefined) throw failure.error;
        return { done: true, value: undefined };
      } finally {
        finish();
      }
    },
  };
};
