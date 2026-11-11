import { irPathKey, irRecordOwnerPaths } from './operation-paths.ts';
import type { IRPath, IRRecord } from './records.ts';

// Finds the unit that a record belongs to. A writer registers each unit at the path
// where its IR structure was initialized.
export const createIRUnitRegistry = <T>() => {
  const units = new Map<string, T>();
  return {
    set: (path: IRPath, unit: T): void => { units.set(irPathKey(path), unit); },
    get: (path: IRPath): T | undefined => units.get(irPathKey(path)),
    has: (path: IRPath): boolean => units.has(irPathKey(path)),
    delete: (path: IRPath): void => { units.delete(irPathKey(path)); },
    forRecord: (record: IRRecord, root: unknown): T | undefined => {
      for (const path of irRecordOwnerPaths(record, root)) {
        const unit = units.get(irPathKey(path));
        if (unit !== undefined) return unit;
      }
      return undefined;
    },
  };
};
