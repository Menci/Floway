import type { Candidate } from '../../../src/data-plane/pipeline/facts.ts';

export const candidateFor = (id: string): Candidate => ({
  upstream: { id, name: id, kind: 'custom', config: {} },
  model: {
    id: 'public-model',
    upstreamModelId: 'wire-model',
    kind: 'chat',
    endpoints: { openaiChatCompletions: {} },
    enabledFlags: [],
    limits: {},
    opaqueBlobCompatibilityScope: { bindToUpstream: true },
  },
});

export const hostFor = <Services>(services: Services) => {
  const controller = new AbortController();
  const pending: Promise<void>[] = [];
  const errors: unknown[] = [];
  return {
    controller,
    errors,
    options: {
      services,
      signal: controller.signal,
      waitUntil(work: Promise<unknown>) {
        pending.push(work.then(() => undefined, error => { errors.push(error); }));
      },
    },
    async settle() {
      for (const work of pending) await work;
    },
  };
};
