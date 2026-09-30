import { createRunReader, type DumpEvent } from '@floway-dev/pipeline';

type Stored = Extract<DumpEvent, { type: 'object' }>['nodes'][number];
type FactState = Readonly<Record<string, Stored>>;

export interface RunStage {
  readonly id: number;
  readonly name: string;
  readonly parentId: number | null;
  readonly children: RunStage[];
  readonly request: FactState;
  response: FactState | null;
  failure: FactState | null;
  readonly logs: Extract<DumpEvent, { type: 'stage.log' }>[];
}

export interface ValueChange {
  readonly path: readonly (string | number)[];
  readonly kind: 'added' | 'removed' | 'changed';
  readonly before?: unknown;
  readonly after?: unknown;
}

const reference = (value: Stored): number | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && '$' in value
    ? value.$ as number : null;

const decodeKey = (key: string): string => key.startsWith('$$') ? key.slice(1) : key;

export const readRun = (ndjson: string) => {
  const read = createRunReader();
  const stages = new Map<number, RunStage>();
  const outcomes = new Map<number, Stored>();
  const roots: RunStage[] = [];
  const stage = (id: number): RunStage => {
    const found = stages.get(id);
    if (found === undefined) throw new Error(`Run references missing stage ${id}`);
    return found;
  };
  const node = (id: number): Stored => {
    const stored = read.node(id);
    return outcomes.has(id) ? { $deferred: outcomes.get(id)! } : stored;
  };
  for (const line of ndjson.split('\n').filter(Boolean)) {
    const event = JSON.parse(line) as DumpEvent;
    switch (event.type) {
    case 'object':
      read(event);
      break;
    case 'stage.entered': {
      const parent = event.parentStageId === null ? null : stage(event.parentStageId);
      const request = event.facts ?? parent?.request;
      if (request === undefined) throw new Error(`Run root stage ${event.stageId} has no request facts`);
      const entered: RunStage = {
        id: event.stageId, name: event.name, parentId: event.parentStageId,
        children: [], logs: [], request, response: null, failure: null,
      };
      stages.set(entered.id, entered);
      (parent === null ? roots : parent.children).push(entered);
      break;
    }
    case 'stage.leaved': stage(event.stageId).response = event.facts; break;
    case 'stage.failed': stage(event.stageId).failure = { error: event.error }; break;
    case 'stage.log': stage(event.stageId).logs.push(event); break;
    case 'stream.frame':
    case 'stream.end': break;
    case 'deferred.settled': {
      const id = reference(event.deferred);
      if (id === null) throw new Error('Run deferred settlement has no object identity');
      outcomes.set(id, event.outcome);
      break;
    }
    }
  }
  // Folded exits inherit the last descent's returned state, including repeated next().
  for (const current of [...stages.values()].reverse()) {
    if (current.failure === null && current.response === null && current.children.length > 0) {
      current.response = current.children.at(-1)!.response;
    }
  }

  const value = (stored: Stored, ancestors: ReadonlySet<number> = new Set()): unknown => {
    const id = reference(stored);
    if (id !== null) {
      if (ancestors.has(id)) return { $cycle: id };
      return value(node(id), new Set([...ancestors, id]));
    }
    if (Array.isArray(stored)) return stored.map(child => value(child, ancestors));
    if (typeof stored !== 'object' || stored === null) return stored;
    return Object.fromEntries(Object.entries(stored).map(([key, child]) => [decodeKey(key), value(child, ancestors)]));
  };
  const state = (facts: FactState): unknown => value(facts);

  const diff = (before: FactState, after: FactState): ValueChange[] => {
    const changes: ValueChange[] = [];
    const compare = (left: Stored, right: Stored, path: readonly (string | number)[], pairs: ReadonlySet<string> = new Set()): void => {
      if (left === right) return;
      const leftId = reference(left);
      const rightId = reference(right);
      if (leftId !== null && rightId !== null) {
        if (leftId === rightId) return;
        const pair = `${leftId}:${rightId}`;
        if (pairs.has(pair)) return;
        pairs = new Set([...pairs, pair]);
      }
      if (leftId !== null || rightId !== null) {
        compare(leftId === null ? left : node(leftId), rightId === null ? right : node(rightId), path, pairs);
        return;
      }
      const leftArray = Array.isArray(left);
      const rightArray = Array.isArray(right);
      if (typeof left === 'object' && left !== null && typeof right === 'object' && right !== null && leftArray === rightArray) {
        const leftEntries = Object.entries(left);
        const rightEntries = Object.entries(right);
        const leftObject = Object.fromEntries(leftEntries) as Record<string, Stored>;
        const rightObject = Object.fromEntries(rightEntries) as Record<string, Stored>;
        for (const key of new Set([...leftEntries.map(([key]) => key), ...rightEntries.map(([key]) => key)])) {
          const nextPath = [...path, leftArray ? Number(key) : decodeKey(key)];
          if (!(key in leftObject)) changes.push({ path: nextPath, kind: 'added', after: value(rightObject[key]!) });
          else if (!(key in rightObject)) changes.push({ path: nextPath, kind: 'removed', before: value(leftObject[key]!) });
          else compare(leftObject[key]!, rightObject[key]!, nextPath, pairs);
        }
        return;
      }
      changes.push({ path, kind: 'changed', before: value(left), after: value(right) });
    };
    compare(before, after, []);
    return changes;
  };
  return { roots, stages: [...stages.values()], state, diff };
};
