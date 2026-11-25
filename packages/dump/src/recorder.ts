import { createDumpEncoder, type Observer } from './encoder.ts';

export const createDumpRecorder = (hostWaitUntil: (work: Promise<unknown>) => void) => {
  const encoder = createDumpEncoder();
  const rootLeft = Promise.withResolvers<void>();
  const failure = Promise.withResolvers<never>();
  const detached = new Set<Promise<unknown>>();
  let controller: ReadableStreamDefaultController<Uint8Array<ArrayBuffer>>;
  let state: 'open' | 'failed' | 'closed' = 'open';
  let rootStageId: number | undefined;
  let finishing: Promise<void> | undefined;

  const fail = (error: unknown): void => {
    if (state !== 'open') return;
    state = 'failed';
    controller.error(error);
    failure.reject(error);
  };
  void failure.promise.catch(() => undefined);

  const body = new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(streamController) { controller = streamController; },
    cancel: fail,
  });

  const events: Observer = (event, idOf) => {
    if (state === 'failed') return;
    if (state === 'closed') throw new Error('Received a pipeline event after its dump closed');
    try {
      controller.enqueue(encoder.encode(event, idOf));
      if (rootStageId === undefined && event.type === 'stage.entered' && event.parentStageId === undefined) rootStageId = event.stageId;
      if (event.type === 'stage.leaved' && event.stageId === rootStageId) rootLeft.resolve();
    } catch (error) {
      fail(error);
      throw error;
    }
  };

  const waitUntil = (work: Promise<unknown>): void => {
    if (state === 'closed') throw new Error('Received detached pipeline work after its dump closed');
    detached.add(work);
    const complete = (): void => { detached.delete(work); };
    void work.then(complete, complete);
    hostWaitUntil(work);
  };

  const finish = (done: Promise<void>): Promise<void> => finishing ??= (async () => {
    // Root exit includes late drains that can register detached work after run.done settles.
    const settled = (): void => {};
    await Promise.race([Promise.all([rootLeft.promise, done.then(settled, settled)]), failure.promise]);
    while (detached.size > 0) await Promise.race([Promise.allSettled(detached), failure.promise]);
    if (state === 'failed') await failure.promise;
    controller.close();
    state = 'closed';
  })();

  return { body, events, waitUntil, finish };
};
