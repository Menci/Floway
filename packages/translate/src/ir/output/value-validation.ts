import { IRAbsent } from './absent.ts';
import { irPathKey, unionVariantNode } from './operation-paths.ts';
import type { IRPath } from './records.ts';
import type { IRSchemaNode } from './schema.ts';
import type { IROutputValue } from './types.ts';

type IROutputValueVisitor = (path: IRPath, node: IRSchemaNode, value: IROutputValue) => void;

const isPlainObject = (value: unknown): value is Record<string, IROutputValue> => typeof value === 'object' && value !== null && !Array.isArray(value);

// Opaque values are replaced as a whole, so only what no IR value may contain is rejected.
const assertPlainValue = (path: IRPath, value: unknown): void => {
  if (value === undefined) throw new TypeError(`IR values cannot contain undefined: ${irPathKey(path)}`);
  if (value === IRAbsent) throw new TypeError(`IRAbsent is not allowed at ${irPathKey(path)}`);
  if (typeof value !== 'object' || value === null) return;
  for (const [key, child] of Object.entries(value)) assertPlainValue([...path, Array.isArray(value) ? Number(key) : key], child);
};

// Walks a value that is about to be written together with the schema node describing it.
// `IRAbsent` is accepted where the schema allows it unless `allowAbsent` is off.
export const walkValue = (path: IRPath, node: IRSchemaNode, value: IROutputValue, visitor: IROutputValueVisitor, { allowAbsent }: { allowAbsent: boolean }): void => {
  if (value === undefined) throw new TypeError(`IR values cannot contain undefined: ${irPathKey(path)}`);
  if (node.kind === 'nullable') {
    if (value === null) return visitor(path, node, value);
    node = node.of;
  }
  visitor(path, node, value);
  switch (node.kind) {
  case 'string':
    if (value === IRAbsent) {
      if (!allowAbsent) throw new TypeError('IRAbsent must be assigned directly to call_id');
      if (node.absent !== true) throw new TypeError(`IRAbsent is not allowed at ${irPathKey(path)}`);
    } else if (typeof value !== 'string') throw new TypeError(`IR value must be a string: ${irPathKey(path)}`);
    return;
  case 'number':
    if (typeof value !== 'number') throw new TypeError(`IR value must be a number: ${irPathKey(path)}`);
    return;
  case 'array':
    if (!Array.isArray(value)) throw new TypeError(`IR value must be an array: ${irPathKey(path)}`);
    value.forEach((child, index) => walkValue([...path, index], node.of, child, visitor, { allowAbsent }));
    return;
  case 'object':
  case 'union': {
    if (!isPlainObject(value)) throw new TypeError(`IR value must be an object: ${irPathKey(path)}`);
    const variant = unionVariantNode(node, value);
    if (variant?.kind !== 'object') throw new TypeError(`IR value has an unknown variant: ${irPathKey(path)}`);
    for (const [key, child] of Object.entries(value)) {
      const field = node.kind === 'union' && key === node.discriminant ? { kind: 'string' } as const : Object.hasOwn(variant.fields, key) ? variant.fields[key] : undefined;
      if (field === undefined) throw new TypeError(`IR value has no field ${key}: ${irPathKey(path)}`);
      walkValue([...path, key], field, child, visitor, { allowAbsent });
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
export const assertComplete = (path: IRPath, node: IRSchemaNode, value: unknown): void => {
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
