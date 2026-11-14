import { IRAbsent } from './absent.ts';
import { createLifecycle } from './lifecycle.ts';
import { irEndedUnit, irPathKey, resolveIRPath, valueAt } from './operation-paths.ts';
import type { IREvent, IRWrite, IRPath } from './records.ts';
import { type IROutput } from './types.ts';
import { assertComplete, walkValue } from './value-validation.ts';

export const createIRCollector = () => {
  const state: IROutput = { choices: [] };
  // Containers created by this collector. Everything else is borrowed from a record and
  // is copied before its first write.
  const owned = new WeakSet<object>([state, state.choices]);
  const lifecycle = createLifecycle();

  const writableContainer = (path: IRPath): Record<string | number, unknown> => {
    let target: Record<string | number, unknown> = state;
    for (const segment of path) {
      const child = target[segment] as object;
      if (!owned.has(child)) {
        const copy = Array.isArray(child) ? [...child] : { ...child };
        owned.add(copy);
        Object.defineProperty(target, segment, { value: copy, writable: true, enumerable: true, configurable: true });
      }
      target = target[segment] as Record<string | number, unknown>;
    }
    return target;
  };

  // Returns whether the write changed the state.
  const applyWrite = (write: IRWrite): boolean => {
    if (write.value === undefined) throw new TypeError('output IR writes cannot carry undefined');
    const { path } = write;
    const resolution = resolveIRPath(path, state);
    if (resolution !== undefined) lifecycle.assertWritable(resolution.units, path);
    const key = path.at(-1);
    if (key === undefined) throw new TypeError('output IR writes require a property path');
    const parentPath = path.slice(0, -1);
    const parent = valueAt(state, parentPath);
    if (parent === undefined) throw new TypeError(`Missing output IR path: ${irPathKey(parentPath)}`);
    if (typeof parent !== 'object' || parent === null) throw new TypeError('output IR write parent must be an object or array');
    const present = Object.hasOwn(parent, key);
    if (write.kind === 'initialize' && present) throw new TypeError('output IR initialize requires an absent target');
    if (Array.isArray(parent)) {
      if (typeof key !== 'number' || !Number.isInteger(key) || key < 0 || key > parent.length) throw new TypeError('output IR array write requires a contiguous nonnegative index');
      if (!present && key !== parent.length) throw new TypeError('output IR array insertion must use the next index');
      if (write.kind === 'initialize' && key !== parent.length) throw new TypeError('output IR array initialization must use the next index');
    }
    const current = (parent as Record<string | number, unknown>)[key];
    const node = resolution?.node;

    if (write.kind === 'append') {
      if (node?.kind !== 'string' || node.append !== true) throw new TypeError(`output IR append requires an append-target path: ${irPathKey(path)}`);
      if (typeof current !== 'string') throw new TypeError('output IR append requires a string target');
      if (typeof write.value !== 'string') throw new TypeError('output IR append requires a string value');
      if (write.value === '') return false;
    } else {
      if (node === undefined) throw new TypeError(`output IR path is not part of the output IR schema: ${irPathKey(path)}`);
      if (write.kind === 'initialize') {
        walkValue(path, node, write.value, (childPath, childNode, child) => {
          if (childNode.kind === 'string' && childNode.append === true && child !== '') throw new TypeError(`output IR append target must initialize to an empty string: ${irPathKey(childPath)}`);
        }, { allowAbsent: true });
      } else if (write.value === IRAbsent) {
        if (node.kind !== 'string' || node.absent !== true) throw new TypeError(`IRAbsent is not allowed at ${irPathKey(path)}`);
        if (present) throw new TypeError('IRAbsent may only be assigned to an absent target');
      } else {
        walkValue(path, node, write.value, (childPath, childNode) => {
          if (childNode.kind === 'string' && childNode.append === true) throw new TypeError(`output IR append target cannot be assigned: ${irPathKey(childPath)}`);
        }, { allowAbsent: false });
        if (present && Object.is(current, write.value)) return false;
      }
    }

    const target = writableContainer(parentPath);
    if (write.kind === 'append') target[key] = (target[key] as string) + write.value;
    else Object.defineProperty(target, key, { value: write.value, writable: true, enumerable: true, configurable: true });
    if (write.kind === 'initialize' && resolution !== undefined) {
      const unit = resolution.units.at(-1);
      if (unit !== undefined && unit.path.length === path.length) lifecycle.openUnit(resolution.units);
    }
    return true;
  };

  const applyEvent = (event: IREvent): void => {
    const ended = irEndedUnit(event);
    if (ended !== undefined) {
      const resolution = resolveIRPath(ended.path, state);
      if (resolution === undefined || valueAt(state, ended.path) === undefined) throw new TypeError(`output IR ${ended.kind} does not exist: ${irPathKey(ended.path)}`);
      lifecycle.closeUnit(resolution.units);
      assertComplete(ended.path, resolution.node, valueAt(state, ended.path));
    } else if (event.type === 'finish') lifecycle.assertFinishable();
  };

  const value = <T = unknown>(path: IRPath): T | undefined => valueAt(state, path) as T | undefined;
  // A tool call that closed without a call ID has none to wait for.
  const valueOrAbsent = <T>(path: IRPath): T | typeof IRAbsent | undefined => {
    const actual = value<T | typeof IRAbsent>(path);
    if (actual !== undefined) return actual;
    const resolution = resolveIRPath(path, state);
    const owner = resolution?.units.at(-1);
    return resolution?.node.kind === 'string' && resolution.node.absent === true && owner !== undefined && lifecycle.isClosed(owner.path) ? IRAbsent : undefined;
  };
  return { state, applyWrite, applyEvent, value, isOpen: lifecycle.isOpen, valueOrAbsent };
};

export type IRCollector = ReturnType<typeof createIRCollector>;
