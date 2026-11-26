import { emptySide, hostFor } from './run-fixture.ts';
import { asEntry, factSpace, run } from '../src/index.ts';
import type { Pipeline } from '../src/index.ts';

export const verifyStageTypes = (): void => {
  const numeric = factSpace<{ value: number }, { value: number }>();
  const textual = factSpace<{ value: string }, { value: string }>();
  const readsNumber = numeric.defineStage({
    name: 'reads-number', request: { needs: ['value'] }, return: { provides: [] },
    execute: async ({ value }) => { value.toFixed(); return {}; },
  });
  const writesNumber = numeric.defineStage({
    name: 'writes-number', request: { needs: [] }, return: { provides: ['value'] },
    execute: async () => ({ value: 42 }),
  });
  textual.compose('bad-stage-input', {
    entry: ['value'], exit: [], stages: [],
    // @ts-expect-error The actual composing request value is a string.
    ending: readsNumber,
  });
  textual.compose('bad-stage-output', {
    entry: [], exit: ['value'], stages: [],
    // @ts-expect-error The actual composing response value is a string.
    ending: writesNumber,
  });

  const readsResponseNumber = numeric.defineStage({
    name: 'reads-response-number',
    through: { request: emptySide, response: { ...emptySide, needs: ['value'] } },
    execute: async (facts, scope) => {
      const answer = await scope.next(facts);
      answer.value.toFixed();
      return answer;
    },
  });
  const writesText = textual.defineStage({
    name: 'writes-text', request: { needs: [] }, return: { provides: ['value'] },
    execute: async () => ({ value: 'text' }),
  });
  textual.compose('bad-response-input', {
    entry: [], exit: ['value'],
    // @ts-expect-error The shared key can carry strings on the response side.
    stages: [readsResponseNumber],
    ending: writesText,
  });
};

export const verifyTargetTypes = (): void => {
  const numeric = factSpace<{ value: number }, { value: string }>();
  const textual = factSpace<{ value: string }, { value: string }>();
  const numericResponse = factSpace<{ value: string }, { value: number }>();
  const numericEnding = numeric.defineStage({
    name: 'numeric-input', request: { needs: ['value'] },
    into: { peer: { request: emptySide, response: { ...emptySide, needs: ['value'] } } },
    execute: async (facts, scope) => await scope.into.peer(facts),
  });
  const textualEnding = textual.defineStage({
    name: 'textual-input', request: { needs: ['value'] },
    into: { peer: { request: emptySide, response: { ...emptySide, needs: ['value'] } } },
    execute: async (facts, scope) => await scope.into.peer(facts),
  });
  const textualCycle: Pipeline<{ value: string }, { value: string }> = textual.compose('textual-cycle', {
    entry: ['value'], exit: ['value'], stages: [], ending: textualEnding,
    // @ts-expect-error The forward target requires a number on the caller's request path.
    targets: { peer: () => numericCycle },
  });
  const numericCycle = numeric.compose('numeric-cycle', {
    entry: ['value'], exit: ['value'], stages: [], ending: numericEnding,
    // @ts-expect-error The reverse target requires a string on the caller's request path.
    targets: { peer: textualCycle },
  });

  const differentResponse = numericResponse.defineStage({
    name: 'wrong-response', request: { needs: ['value'] }, return: { provides: ['value'] },
    execute: async ({ value }) => ({ value: value.length }),
  });
  const wrongResponse = numericResponse.compose('wrong-response', {
    entry: ['value'], exit: ['value'], stages: [], ending: differentResponse,
  });
  textual.compose('bad-target-output', {
    entry: ['value'], exit: ['value'], stages: [], ending: textualEnding,
    // @ts-expect-error The target cannot supply the textual response value consumed by this edge.
    targets: { peer: wrongResponse },
  });
};

export const verifyCheckedEntriesAndOptionals = (): void => {
  const { defineStage, compose } = factSpace<{ label: string }, { label: number }>();
  const terminal = defineStage({
    name: 'label-length', request: { needs: ['label?'] }, return: { provides: ['label?'] },
    execute: async ({ label }) => ({ ...(label !== undefined && { label: label.length }) }),
  });
  const pipeline = compose('label-length', {
    entry: ['label?'], exit: ['label?'], stages: [], ending: terminal,
  });
  const { options } = hostFor({});
  // @ts-expect-error An unchecked definition does not carry entry authority.
  void run(pipeline, {}, options);
  const entry = asEntry(pipeline);
  const answer: Promise<{ label?: number }> = run(entry, { label: 'present' }, options).result;
  void answer;
  // @ts-expect-error Optional does not permit a present undefined value.
  void run(entry, { label: undefined }, options);
};

export const verifyPassthroughTargetTypes = (): void => {
  const numeric = factSpace<object, { value: number; metadata: number }>();
  const textual = factSpace<object, { value: string; output: string }>();
  const valueStage = numeric.defineStage({
    name: 'value', request: { needs: [] }, return: { provides: ['value'] }, execute: async () => ({ value: 42 }),
  });
  const valueTarget = numeric.compose('value', { entry: [], exit: ['value'], stages: [], ending: valueStage });
  const metadataStage = numeric.defineStage({
    name: 'metadata', request: { needs: [] }, return: { provides: ['metadata'] }, execute: async () => ({ metadata: 42 }),
  });
  const metadataTarget = numeric.compose('metadata', { entry: [], exit: ['metadata'], stages: [], ending: metadataStage });
  const relay = textual.defineStage({
    name: 'relay', request: { needs: [] }, into: { target: { request: emptySide, response: emptySide } },
    execute: async (facts, scope) => await scope.into.target(facts),
  });
  textual.compose('bad-public-exit', {
    entry: [], exit: ['value'], stages: [], ending: relay,
    // @ts-expect-error The numeric value would pass through to the textual public exit.
    targets: { target: valueTarget },
  });
  const consumer = textual.defineStage({
    name: 'text-consumer', through: { request: emptySide, response: { needs: ['value'], consumes: ['value'], provides: ['output'] } },
    execute: async (facts, scope) => {
      const { value, ...rest } = await scope.next(facts);
      return { ...rest, output: value.toUpperCase() };
    },
  });
  textual.compose('bad-downstream-consumer', {
    entry: [], exit: ['output'], stages: [consumer], ending: relay,
    // @ts-expect-error The numeric value would pass through to a later stage's textual response needs.
    targets: { target: valueTarget },
  });
  const mixed = textual.defineStage({
    name: 'mixed',
    through: { request: emptySide, response: { ...emptySide, provides: ['value'] } },
    return: { provides: [] },
    execute: async (facts, scope) => await scope.next(facts),
  });
  textual.compose('bad-mixed-return', {
    entry: [], exit: ['value?'], stages: [mixed], ending: relay,
    // @ts-expect-error The independent return permits the untyped pass-through to reach the textual exit.
    targets: { target: valueTarget },
  });
  const stringValue = textual.defineStage({
    name: 'text-value', request: { needs: [] }, return: { provides: ['value'] },
    execute: async () => ({ value: 'text' }),
  });
  const textTarget = textual.compose('text-value', { entry: [], exit: ['value'], stages: [], ending: stringValue });
  const crossArm = textual.defineStage({
    name: 'cross-arm',
    request: { needs: [] },
    into: {
      keeping: { request: emptySide, response: emptySide },
      consuming: { request: emptySide, response: { ...emptySide, consumes: ['value'] } },
    },
    execute: async (facts, scope) => {
      await scope.into.keeping(facts);
      return await scope.into.consuming(facts);
    },
  });
  textual.compose('bad-cross-arm', {
    entry: [], exit: ['value?'], stages: [], ending: crossArm,
    // @ts-expect-error The keeping arm may accept a value from the consuming child answer.
    targets: { keeping: textTarget, consuming: valueTarget },
  });

  const optional = factSpace<object, { value: number; metadata: string }>();
  const optionalRelay = optional.defineStage({
    name: 'optional-metadata', request: { needs: [] },
    into: { target: { request: emptySide, response: { ...emptySide, needs: ['metadata?'], consumes: ['metadata'] } } },
    execute: async (facts, scope) => {
      const { metadata, ...rest } = await scope.into.target(facts);
      metadata?.toUpperCase();
      return rest;
    },
  });
  optional.compose('absent-optional-metadata', {
    entry: [], exit: ['value'], stages: [], ending: optionalRelay, targets: { target: valueTarget },
  });
  optional.compose('bad-optional-metadata', {
    entry: [], exit: [], stages: [], ending: optionalRelay,
    // @ts-expect-error A supplied optional response value must satisfy the caller's declared type.
    targets: { target: metadataTarget },
  });
};

export const verifyKeyInventory = (): void => {
  type Request = { seed: number; label: string };
  type Response = { value: number; note: string };
  const { defineStage, compose } = factSpace<Request, Response>();
  const terminal = defineStage({
    name: 'terminal', request: { needs: ['seed', 'label?'] }, return: { provides: ['value', 'note?'] },
    execute: async ({ seed, label }) => ({ value: seed, ...(label !== undefined && { note: label }) }),
  });
  const pipeline = compose('terminal', { entry: ['seed', 'label?'], exit: ['value', 'note?'], stages: [], ending: terminal });
  // @ts-expect-error A peer annotation cannot erase required target output keys.
  const eraseRequired: Pipeline<{ seed: number; label?: string }, object> = pipeline;
  // @ts-expect-error A peer annotation cannot erase optional target output keys.
  const eraseOptional: Pipeline<{ seed: number; label?: string }, { value: number }> = pipeline;
  // @ts-expect-error A peer annotation cannot erase optional target input keys.
  const eraseInput: Pipeline<{ seed: number }, { value: number; note?: string }> = pipeline;
  const safeValueTypes: Pipeline<{ seed: 1; label?: string }, { value: number; note?: string | number }> = pipeline;
  void [eraseRequired, eraseOptional, eraseInput, safeValueTypes];

  const caller = factSpace<{ seed: number }, Response>();
  const relay = caller.defineStage({
    name: 'relay', request: { needs: ['seed'] },
    into: { target: { request: emptySide, response: { ...emptySide, needs: ['value'] } } },
    execute: async (facts, scope) => await scope.into.target(facts),
  });
  caller.compose('unknown-optional-entry', {
    entry: ['seed'], exit: ['value', 'note?'], stages: [], ending: relay,
    // @ts-expect-error An open request can carry an untyped extra value at the target's optional input key.
    targets: { target: pipeline },
  });
};

export const verifyRequestConsumption = (): void => {
  type Response = { delivered: number };
  const outer = factSpace<{ label: number }, Response>();
  const inner = factSpace<{ label: string }, Response>();
  const source = inner.defineStage({
    name: 'textual-label', request: { needs: ['label?'] }, return: { provides: ['delivered'] },
    execute: async ({ label }) => ({ delivered: label?.length ?? 0 }),
  });
  const target = inner.compose('target', { entry: ['label?'], exit: ['delivered'], stages: [], ending: source });
  const consume = outer.defineStage({
    name: 'consume-label',
    through: {
      request: { ...emptySide, needs: ['label?'], consumes: ['label'] },
      response: { ...emptySide, needs: ['delivered'] },
    },
    execute: async ({ label: _, ...rest }, scope) => await scope.next(rest),
  });
  const restore = outer.defineStage({
    name: 'restore-label',
    through: {
      request: { ...emptySide, provides: ['label?'] },
      response: { ...emptySide, needs: ['delivered'] },
    },
    execute: async (facts, scope) => await scope.next({ ...facts, label: 17 }),
  });
  const relay = outer.defineStage({
    name: 'relay', request: { needs: [] },
    into: { target: { request: emptySide, response: { ...emptySide, needs: ['delivered'] } } },
    execute: async (facts, scope) => await scope.into.target(facts),
  });
  const restoreAtEdge = outer.defineStage({
    name: 'restore-at-edge', request: { needs: [] },
    into: {
      target: {
        request: { ...emptySide, provides: ['label'] },
        response: { ...emptySide, needs: ['delivered'] },
      },
    },
    execute: async (facts, scope) => await scope.into.target({ ...facts, label: 17 }),
  });
  outer.compose('optional-restore', {
    entry: ['label?'], exit: ['delivered'], stages: [consume, restore], ending: relay,
    // @ts-expect-error An optional write can reintroduce the incompatible value.
    targets: { target },
  });
  outer.compose('edge-restore', {
    entry: ['label?'], exit: ['delivered'], stages: [consume], ending: restoreAtEdge,
    // @ts-expect-error An edge that provides the consumed key can no longer omit it from the type check.
    targets: { target },
  });
  const widened: readonly (typeof consume)[] = [consume];
  outer.compose('widened-stages', {
    entry: ['label?'], exit: ['delivered'], stages: widened, ending: relay,
    // @ts-expect-error This array type also admits an assembly that never consumes the key.
    targets: { target },
  });
};
