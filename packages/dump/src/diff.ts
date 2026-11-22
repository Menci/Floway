import type { DumpDecoder, DumpViewModel } from './decoder.ts';
import type { StoredRecord, StoredValue } from './types.ts';

export type DiffPathSegment = string | number;

export interface StructuralDiffEntry {
  readonly path: readonly DiffPathSegment[];
  readonly kind: 'added' | 'removed' | 'changed';
  readonly before?: unknown;
  readonly after?: unknown;
}

export interface StageDiff {
  readonly childStageId: number;
  readonly childName: string;
  readonly entries: readonly StructuralDiffEntry[];
}

export interface StageDiffs {
  readonly downward: readonly StageDiff[];
  readonly upward: readonly StageDiff[];
}

const isStoredRecord = (value: StoredValue): value is StoredRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const referenceId = (value: StoredValue): number | undefined =>
  isStoredRecord(value) && typeof value.$ === 'number' ? value.$ : undefined;
const storedTag = (value: StoredRecord): string | undefined =>
  Object.keys(value).find(key => key.startsWith('$') && !key.startsWith('$$'));

export const diffStoredValues = (
  before: StoredValue | undefined, after: StoredValue | undefined, decoder: DumpDecoder,
): readonly StructuralDiffEntry[] => {
  if (before === undefined && after === undefined) return [];
  if (before === undefined) return [{ path: [], kind: 'added', after: decoder.resolve(after!) }];
  if (after === undefined) return [{ path: [], kind: 'removed', before: decoder.resolve(before) }];

  const entries: StructuralDiffEntry[] = [];
  const ancestors = new Set<string>();

  const node = (id: number): StoredValue => {
    const stored = decoder.getStoredNode(id);
    if (stored === undefined) throw new Error(`Missing dump object ${id}`);
    return stored;
  };

  const walk = (left: StoredValue, right: StoredValue, path: readonly DiffPathSegment[]): void => {
    if (Object.is(left, right)) return;
    const leftId = referenceId(left);
    const rightId = referenceId(right);
    if (leftId !== undefined && rightId !== undefined) {
      if (leftId === rightId) return;
      const pair = `${leftId}:${rightId}`;
      if (ancestors.has(pair)) return;
      ancestors.add(pair);
      walk(node(leftId), node(rightId), path);
      ancestors.delete(pair);
      return;
    }
    if (leftId !== undefined || rightId !== undefined) {
      walk(leftId === undefined ? left : node(leftId), rightId === undefined ? right : node(rightId), path);
      return;
    }
    if (Array.isArray(left) && Array.isArray(right)) {
      for (let index = 0; index < Math.max(left.length, right.length); index++) {
        const childPath = [...path, index];
        if (index >= left.length) entries.push({ path: childPath, kind: 'added', after: decoder.resolve(right[index]) });
        else if (index >= right.length) entries.push({ path: childPath, kind: 'removed', before: decoder.resolve(left[index]) });
        else walk(left[index], right[index], childPath);
      }
      return;
    }
    if (isStoredRecord(left) && isStoredRecord(right)) {
      const tag = storedTag(left);
      const rightTag = storedTag(right);
      if (tag === undefined && rightTag === undefined) {
        for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
          const childPath = [...path, key.startsWith('$$') ? key.slice(1) : key];
          if (!Object.hasOwn(left, key)) entries.push({ path: childPath, kind: 'added', after: decoder.resolve(right[key]) });
          else if (!Object.hasOwn(right, key)) entries.push({ path: childPath, kind: 'removed', before: decoder.resolve(left[key]) });
          else walk(left[key], right[key], childPath);
        }
        return;
      }
      if (tag !== undefined && tag === rightTag) {
        if (tag === '$secret') {
          const l = left.$secret as StoredRecord;
          const r = right.$secret as StoredRecord;
          if (l.hash === r.hash) return;
        } else if (Object.is(left[tag], right[tag])) return;
      }
    }
    entries.push({ path, kind: 'changed', before: decoder.resolve(left), after: decoder.resolve(right) });
  };
  walk(before, after, []);
  return entries;
};

export const computeStageDiffs = (model: DumpViewModel, decoder: DumpDecoder, stageId: number): StageDiffs => {
  const stage = model.stages.get(stageId);
  if (stage === undefined) throw new Error(`Unknown dump stage ${stageId}`);
  const downward: StageDiff[] = [];
  const upward: StageDiff[] = [];
  for (const childStageId of stage.childStageIds) {
    const child = model.stages.get(childStageId);
    if (child === undefined) throw new Error(`Missing dump child stage ${childStageId}`);
    const childName = child.name;
    downward.push({ childStageId, childName, entries: diffStoredValues(stage.encodedFacts, child.encodedFacts, decoder) });
    if (childStageId === stage.baseChildId) {
      upward.push({
        childStageId, childName,
        entries: diffStoredValues(child.encodedResponseFacts, stage.encodedResponseFacts, decoder),
      });
    }
  }
  return { downward, upward };
};
