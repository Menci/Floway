export const hostFor = <S>(services: S) => {
  const controller = new AbortController();
  const background: Promise<void>[] = [];
  const errors: unknown[] = [];
  const waitUntil = (work: Promise<unknown>): void => {
    background.push(work.then(() => undefined, error => { errors.push(error); }));
  };
  return {
    controller,
    background,
    errors,
    options: { services, signal: controller.signal, waitUntil },
    settle: async (): Promise<void> => {
      for (const work of background) await work;
    },
  };
};

export const emptySide = { needs: [], provides: [], consumes: [] } as const;
