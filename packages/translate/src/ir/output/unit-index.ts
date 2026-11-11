import { irPathKey } from './operation-paths.ts';
import type { IRPath } from './records.ts';

// Numbers the native units (blocks, output items, tool calls) of a stream in the order
// they open, and forgets a unit when it closes.
export const createIRUnitIndexAllocator = () => {
  const indices = new Map<string, number>();
  let next = 0;
  const open = (path: IRPath): number => {
    const key = irPathKey(path);
    if (indices.has(key)) throw new TypeError(`IR unit is already open: ${key}`);
    const index = next++;
    indices.set(key, index);
    return index;
  };
  const get = (path: IRPath): number => {
    const key = irPathKey(path);
    const index = indices.get(key);
    if (index === undefined) throw new TypeError(`Unknown open IR unit: ${key}`);
    return index;
  };
  const close = (path: IRPath): void => {
    get(path);
    indices.delete(irPathKey(path));
  };
  return { open, get, close };
};
