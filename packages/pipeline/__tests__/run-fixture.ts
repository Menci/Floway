import type { run, RunEvent } from '../src/index.ts';

type Observer = NonNullable<Parameters<typeof run>[2]['events']>;

export const host = <S>(services: S, observe?: Observer) => {
  const controller = new AbortController();
  const events: RunEvent[] = [];
  const workers: Promise<unknown>[] = [];
  const rootLeft = Promise.withResolvers<RunEvent>();
  const observer: Observer = (event, idOf) => {
    events.push(event);
    if (event.type === 'stage.leaved' && event.stageId === 1) rootLeft.resolve(event);
    observe?.(event, idOf);
  };
  return {
    controller,
    events,
    workers,
    rootLeft: rootLeft.promise,
    options: {
      services,
      signal: controller.signal,
      waitUntil: (work: Promise<unknown>): void => { workers.push(work); },
      events: observer,
    },
  };
};

export const aborted = (signal: AbortSignal): Promise<void> => signal.aborted
  ? Promise.resolve()
  : new Promise(resolve => { signal.addEventListener('abort', () => { resolve(); }, { once: true }); });
