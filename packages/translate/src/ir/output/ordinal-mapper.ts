import { irPathKey } from './operation-paths.ts';
import type { IRPath } from './stream.ts';

// Numbers the native units (blocks, output items, tool calls) of a stream in the order
// they open, and forgets a unit when it closes.
export const createIROrdinalMapper = () => {
  const ordinals = new Map<string, number>();
  let next = 0;
  const open = (path: IRPath): number => {
    const key = irPathKey(path);
    if (ordinals.has(key)) throw new TypeError(`IR unit is already open: ${key}`);
    const ordinal = next++;
    ordinals.set(key, ordinal);
    return ordinal;
  };
  const get = (path: IRPath): number => {
    const key = irPathKey(path);
    const ordinal = ordinals.get(key);
    if (ordinal === undefined) throw new TypeError(`Unknown open IR unit: ${key}`);
    return ordinal;
  };
  const close = (path: IRPath): void => {
    get(path);
    ordinals.delete(irPathKey(path));
  };
  return { open, get, close };
};
