import { irEndedUnit, irPathKey, resolveIRPath, unionVariantNode, valueAt, type IRUnit } from './operation-paths.ts';
import type { IRSchemaNode } from './schema.ts';
import type { IREvent, IRWrite, IRPath } from './stream.ts';
import { IRAbsent, type IR, type IRValue } from './types.ts';

type IRValueVisitor = (path: IRPath, node: IRSchemaNode, value: IRValue) => void;

const isPlainObject = (value: unknown): value is Record<string, IRValue> => typeof value === 'object' && value !== null && !Array.isArray(value);

// Opaque values are replaced as a whole, so only what no IR value may contain is rejected.
const assertPlainValue = (path: IRPath, value: unknown): void => {
  if (value === undefined) throw new TypeError(`IR values cannot contain undefined: ${irPathKey(path)}`);
  if (value === IRAbsent) throw new TypeError(`IRAbsent is not allowed at ${irPathKey(path)}`);
  if (typeof value !== 'object' || value === null) return;
  for (const [key, child] of Object.entries(value)) assertPlainValue([...path, Array.isArray(value) ? Number(key) : key], child);
};

// Walks a value that is about to be written together with the schema node describing it.
// `IRAbsent` is accepted where the schema allows it unless `allowNone` is off.
const walkValue = (path: IRPath, node: IRSchemaNode, value: IRValue, visitor: IRValueVisitor, allowNone: boolean): void => {
  if (value === undefined) throw new TypeError(`IR values cannot contain undefined: ${irPathKey(path)}`);
  if (node.kind === 'nullable') {
    if (value === null) return visitor(path, node, value);
    node = node.of;
  }
  visitor(path, node, value);
  switch (node.kind) {
  case 'string':
    if (value === IRAbsent) {
      if (!allowNone) throw new TypeError('IRAbsent must be assigned directly to call_id');
      if (node.absent !== true) throw new TypeError(`IRAbsent is not allowed at ${irPathKey(path)}`);
    } else if (typeof value !== 'string') throw new TypeError(`IR value must be a string: ${irPathKey(path)}`);
    return;
  case 'number':
    if (typeof value !== 'number') throw new TypeError(`IR value must be a number: ${irPathKey(path)}`);
    return;
  case 'array':
    if (!Array.isArray(value)) throw new TypeError(`IR value must be an array: ${irPathKey(path)}`);
    value.forEach((child, index) => walkValue([...path, index], node.of, child, visitor, allowNone));
    return;
  case 'object':
  case 'union': {
    if (!isPlainObject(value)) throw new TypeError(`IR value must be an object: ${irPathKey(path)}`);
    const variant = unionVariantNode(node, value);
    if (variant?.kind !== 'object') throw new TypeError(`IR value has an unknown variant: ${irPathKey(path)}`);
    for (const [key, child] of Object.entries(value)) {
      const field = node.kind === 'union' && key === node.discriminant ? { kind: 'string' } as const : Object.hasOwn(variant.fields, key) ? variant.fields[key] : undefined;
      if (field === undefined) throw new TypeError(`IR value has no field ${key}: ${irPathKey(path)}`);
      walkValue([...path, key], field, child, visitor, allowNone);
    }
    return;
  }
  case 'opaque':
    assertPlainValue(path, value);
    return;
  default:
  }
};

// Fails if a unit that has ended lacks any field required by its schema.
const assertComplete = (path: IRPath, node: IRSchemaNode, value: unknown): void => {
  const actual = unionVariantNode(node, value);
  if (actual === undefined || typeof value !== 'object' || value === null) return;
  if (actual.kind === 'array') (value as unknown[]).forEach((child, index) => assertComplete([...path, index], actual.of, child));
  else if (actual.kind === 'object') {
    const present = value as Record<string, unknown>;
    if (actual.requiresAnyOf !== undefined && !actual.requiresAnyOf.some(key => present[key] !== undefined)) {
      throw new TypeError(`IR value requires one of ${actual.requiresAnyOf.join(', ')}: ${irPathKey(path)}`);
    }
    for (const [key, field] of Object.entries(actual.fields)) {
      if (!Object.hasOwn(present, key)) {
        if (!actual.optional.includes(key)) throw new TypeError(`IR value requires field ${key}: ${irPathKey(path)}`);
        continue;
      }
      assertComplete([...path, key], field, present[key]);
    }
  }
};

const createCounter = <K>() => {
  const counts = new Map<K, number>();
  return {
    get: (key: K): number => counts.get(key) ?? 0,
    increment: (key: K): void => { counts.set(key, (counts.get(key) ?? 0) + 1); },
    decrement: (key: K): void => {
      const count = counts.get(key);
      if (count === undefined) throw new TypeError(`IR lifecycle counter underflow: ${String(key)}`);
      if (count === 1) counts.delete(key);
      else counts.set(key, count - 1);
    },
  };
};

// Tracks which units (choices, items and parts) are open or closed.
const createLifecycle = () => {
  const open = new Set<string>();
  const closed = new Set<string>();
  const openChildren = createCounter<string>();

  const assertWritable = (units: readonly IRUnit[], path: IRPath): void => {
    for (const unit of units) if (closed.has(irPathKey(unit.path))) throw new TypeError(`IR write targets a closed ${unit.kind}: ${irPathKey(path)}`);
  };

  // `units` ends with the unit that was initialized.
  const begin = (units: readonly IRUnit[]): void => {
    open.add(irPathKey(units[units.length - 1].path));
    if (units.length > 1) openChildren.increment(irPathKey(units[units.length - 2].path));
  };

  const end = (units: readonly IRUnit[]): void => {
    const unit = units[units.length - 1];
    const key = irPathKey(unit.path);
    if (!open.delete(key)) throw new TypeError(`IR ${unit.kind} is not open: ${key}`);
    if (openChildren.get(key) !== 0) throw new TypeError(`IR ${unit.kind} ended with an open unit inside it: ${key}`);
    closed.add(key);
    if (units.length > 1) openChildren.decrement(irPathKey(units[units.length - 2].path));
  };

  const assertFinishable = (): void => {
    if (open.size !== 0) throw new TypeError('IR finish arrived with open units');
  };

  return { assertWritable, begin, end, assertFinishable, isOpen: (path: IRPath): boolean => open.has(irPathKey(path)), isClosed: (path: IRPath): boolean => closed.has(irPathKey(path)) };
};

export const createIRCollector = () => {
  const state: IR = { choices: [] };
  // Containers created by this collector. Everything else is borrowed from a record and
  // is copied before its first write.
  const owned = new WeakSet<object>([state, state.choices]);
  const lifecycle = createLifecycle();

  const writableContainer = (path: IRPath): Record<string | number, unknown> => {
    let target = state as unknown as Record<string | number, unknown>;
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
  const apply = (write: IRWrite): boolean => {
    if (write.value === undefined) throw new TypeError('IR writes cannot carry undefined');
    const { path } = write;
    const resolution = resolveIRPath(path, state);
    if (resolution !== undefined) lifecycle.assertWritable(resolution.units, path);
    const key = path.at(-1);
    if (key === undefined) throw new TypeError('IR writes require a property path');
    const parentPath = path.slice(0, -1);
    const parent = valueAt(state, parentPath);
    if (parent === undefined) throw new TypeError(`Missing IR path: ${irPathKey(parentPath)}`);
    if (typeof parent !== 'object' || parent === null) throw new TypeError('IR write parent must be an object or array');
    const present = Object.hasOwn(parent, key);
    if (write.kind === 'initialize' && present) throw new TypeError('IR initialize requires an absent target');
    if (Array.isArray(parent)) {
      if (typeof key !== 'number' || !Number.isInteger(key) || key < 0 || key > parent.length) throw new TypeError('IR array write requires a contiguous nonnegative index');
      if (!present && key !== parent.length) throw new TypeError('IR array insertion must use the next index');
      if (write.kind === 'initialize' && key !== parent.length) throw new TypeError('IR array initialization must use the next index');
    }
    const current = (parent as Record<string | number, unknown>)[key];
    const node = resolution?.node;

    if (write.kind === 'append') {
      if (node?.kind !== 'string' || node.append !== true) throw new TypeError(`IR append requires an append-target path: ${irPathKey(path)}`);
      if (typeof current !== 'string') throw new TypeError('IR append requires a string target');
      if (typeof write.value !== 'string') throw new TypeError('IR append requires a string value');
      if (write.value === '') return false;
    } else {
      if (node === undefined) throw new TypeError(`IR path is not part of the IR schema: ${irPathKey(path)}`);
      if (write.kind === 'initialize') {
        walkValue(path, node, write.value, (childPath, childNode, child) => {
          if (childNode.kind === 'string' && childNode.append === true && child !== '') throw new TypeError(`IR append target must initialize to an empty string: ${irPathKey(childPath)}`);
        }, true);
      } else if (write.value === IRAbsent) {
        if (node.kind !== 'string' || node.absent !== true) throw new TypeError(`IRAbsent is not allowed at ${irPathKey(path)}`);
        if (present) throw new TypeError('IRAbsent may only be assigned to an absent target');
      } else {
        walkValue(path, node, write.value, (childPath, childNode) => {
          if (childNode.kind === 'string' && childNode.append === true) throw new TypeError(`IR append target cannot be assigned: ${irPathKey(childPath)}`);
        }, false);
        if (present && Object.is(current, write.value)) return false;
      }
    }

    const target = writableContainer(parentPath);
    if (write.kind === 'append') target[key] = (target[key] as string) + write.value;
    else Object.defineProperty(target, key, { value: write.value, writable: true, enumerable: true, configurable: true });
    if (write.kind === 'initialize' && resolution !== undefined) {
      const unit = resolution.units.at(-1);
      if (unit !== undefined && unit.path.length === path.length) lifecycle.begin(resolution.units);
    }
    return true;
  };

  const applyEvent = (event: IREvent): void => {
    const ended = irEndedUnit(event);
    if (ended !== undefined) {
      const resolution = resolveIRPath(ended.path, state);
      if (resolution === undefined || valueAt(state, ended.path) === undefined) throw new TypeError(`IR ${ended.kind} does not exist: ${irPathKey(ended.path)}`);
      lifecycle.end(resolution.units);
      assertComplete(ended.path, resolution.node, valueAt(state, ended.path));
    } else if (event.type === 'finish') lifecycle.assertFinishable();
  };

  const value = <T = unknown>(path: IRPath): T | undefined => valueAt(state, path) as T | undefined;
  // A tool call that closed without a call ID has none to wait for.
  const optional = <T>(path: IRPath): T | typeof IRAbsent | undefined => {
    const actual = value<T | typeof IRAbsent>(path);
    if (actual !== undefined) return actual;
    const resolution = resolveIRPath(path, state);
    const owner = resolution?.units.at(-1);
    return resolution?.node.kind === 'string' && resolution.node.absent === true && owner !== undefined && lifecycle.isClosed(owner.path) ? IRAbsent : undefined;
  };
  return { state, apply, applyEvent, value, isOpen: lifecycle.isOpen, optional };
};

export type IRCollector = ReturnType<typeof createIRCollector>;
