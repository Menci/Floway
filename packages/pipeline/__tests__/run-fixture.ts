import { createHostScope, defineFacts, optional, required } from '../src/index.ts';
import type { FactSpace } from '../src/index.ts';

export const emptySide = { needs: {}, provides: {}, consumes: [] } as const;

export const hostFor = <S extends object>(services: S) => {
  const controller = new AbortController();
  const background: Promise<unknown>[] = [];
  const errors: unknown[] = [];
  const waitUntil = (work: Promise<unknown>): void => {
    background.push(work.catch(error => { errors.push(error); }));
  };
  const host = createHostScope({ signal: controller.signal, waitUntil });
  const settle = async (): Promise<void> => {
    let seen = 0;
    while (seen < background.length) {
      const batch = background.slice(seen);
      seen = background.length;
      await Promise.all(batch);
    }
  };
  return { controller, host, services, background, errors, settle };
};

export const RESPONSE_CANARY_KEY = '__floway_pipeline_response_canary__' as const;

export interface ResponseCanaryFacts {
  readonly [RESPONSE_CANARY_KEY]: symbol;
}

const canarySpace = defineFacts<object, ResponseCanaryFacts>();

export const createResponseCanary = <Rq extends object, Rs extends object, S extends object = object>(
  base: FactSpace<Rq, Rs, S>,
  description = 'floway-response-canary',
) => {
  const token = Symbol(description);
  const space = base.extend<object, ResponseCanaryFacts, S>();

  const inject = canarySpace.defineStage({
    name: 'canary.inject',
    through: {
      request: emptySide,
      response: { needs: {}, provides: { [RESPONSE_CANARY_KEY]: required<symbol>() }, consumes: [] },
    },
    execute: async (facts, scope) => ({
      ...(await scope.next(facts)),
      [RESPONSE_CANARY_KEY]: token,
    }),
  });

  const strip = canarySpace.defineStage({
    name: 'canary.strip',
    through: {
      request: emptySide,
      response: {
        needs: { [RESPONSE_CANARY_KEY]: optional<symbol>() },
        provides: {},
        consumes: [RESPONSE_CANARY_KEY],
      },
    },
    execute: async (facts, scope) => {
      const { [RESPONSE_CANARY_KEY]: _, ...rest } = await scope.next(facts);
      return rest;
    },
  });

  return Object.freeze({ token, space, inject, strip });
};
