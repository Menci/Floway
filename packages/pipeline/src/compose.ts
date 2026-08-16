// Assembly checks what types cannot, per trait, along the array — O(n) per trait, not
// O(2ⁿ) over which stages took which path. Envoy validates terminal-filter position at
// config load for the same reason and it works for the same reason.
//
// The entry contract is derived rather than declared: a need nobody provided joins it, and
// a need an earlier stage **consumed** is an assembly error. The second is the load-bearing
// one — a key an earlier stage consumed cannot be needed below it, so a translated request
// cannot re-enter its own chain, and assembly says so rather than a runtime guard.

import type { Facts } from './facts.ts';
import { walk } from './run.ts';
import type { Pipeline, Recorder, Stage } from './stage.ts';

export const compose = <Entry extends object, Exit extends object>(
  name: string,
  stages: readonly Stage[],
): Pipeline<Entry, Exit> => {
  const have = new Set<string>();               // a stage below can read it
  const consumedBy = new Map<string, string>(); // gone, and who took it
  const entry = new Set<string>();              // therefore the caller must bring it
  const neededAbove = new Set<string>();        // response keys the stages above declared

  stages.forEach((stage, index) => {
    const pass = stage.through ?? stage.into;

    if (stage.into !== undefined && index !== stages.length - 1) {
      throw new Error(`compose(${name}): ${stage.name} declares 'into' but is not last`);
    }
    if (pass === undefined && stage.return === undefined) {
      throw new Error(`compose(${name}): ${stage.name} declares neither a way down nor a way to answer`);
    }
    // A stage that may answer must cover what the stages above it declared needing, or
    // short-circuiting leaves them without a fact they said they need.
    if (stage.return !== undefined) {
      const uncovered = [...neededAbove].filter(key => !stage.return!.provides.includes(key));
      if (uncovered.length > 0) {
        throw new Error(
          `compose(${name}): ${stage.name} may answer here, but its short-circuit does not provide `
          + `${uncovered.join(', ')}, which stages above it need`,
        );
      }
    }
    if (pass === undefined) return;

    // The response direction flows the other way: what this stage provides on the way up
    // satisfies the stages above it, so it clears their outstanding needs before this
    // stage adds its own.
    for (const key of pass.response.provides) neededAbove.delete(key);
    for (const key of pass.request.needs) {
      if (have.has(key)) continue;
      const taker = consumedBy.get(key);
      if (taker !== undefined) {
        throw new Error(`compose(${name}): ${stage.name} needs ${key}, which ${taker} consumed above it`);
      }
      entry.add(key);
    }
    for (const key of pass.request.consumes) { have.delete(key); consumedBy.set(key, stage.name); }
    for (const key of pass.request.provides) { have.add(key); consumedBy.delete(key); }
    // The mirror of the request-direction error. A stage that takes a response key and
    // does not hand it on leaves a stage above it needing something that cannot arrive.
    for (const key of pass.response.consumes) {
      if (pass.response.provides.includes(key) || !neededAbove.has(key)) continue;
      throw new Error(`compose(${name}): ${stage.name} consumes ${key} on the way up, which a stage above it needs`);
    }
    for (const key of pass.response.needs) neededAbove.add(key);
  });

  return {
    name,
    entryNeeds: [...entry] as unknown as readonly (keyof Entry)[],
    enter: async (facts, services, into?: Recorder) => (await walk(name, stages, 0, facts as Facts, services, into)) as unknown as Exit,
  };
};
