import { irSchema, type IRObjectNode, type IRSchemaNode, type IRUnionNode, type IRUnitKind } from './schema.ts';
import type { IREvent, IRPath, IRRecord } from './stream.ts';

// Everything here is derived from the schema in schema.ts. A path is resolved against the
// schema, and the answers come from the traits of the node it lands on. Where the node
// depends on which variant of a union the IR holds there, the variant is read from `root`
// (the accumulated IR), so `root` must already contain the structure the path goes through.

export const irPathKey = (path: IRPath): string => JSON.stringify(path);

export const valueAt = (root: unknown, path: IRPath): unknown => {
  let value = root;
  for (const key of path) {
    if (typeof value !== 'object' || value === null || !Object.hasOwn(value, key)) return undefined;
    value = (value as Record<string | number, unknown>)[key];
  }
  return value;
};

const unitKindOf = (node: IRSchemaNode): IRUnitKind | undefined => node.kind === 'object' || node.kind === 'union' ? node.unit : undefined;

const discriminantNode: IRSchemaNode = { kind: 'string' };

const variantOf = (union: IRUnionNode, value: unknown): IRObjectNode | undefined => {
  const tag = typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[union.discriminant] : undefined;
  return typeof tag === 'string' && Object.hasOwn(union.cases, tag) ? union.cases[tag] : undefined;
};

// The node a value lives in, ignoring the variant choice of unions and the nullability.
export const unionVariantNode = (node: IRSchemaNode, value: unknown): IRSchemaNode | undefined => {
  const unwrapped = node.kind === 'nullable' ? node.of : node;
  return unwrapped.kind === 'union' ? variantOf(unwrapped, value) : unwrapped;
};

const childNode = (node: IRSchemaNode, key: string | number, valueOfNode: unknown): IRSchemaNode | undefined => {
  const actual = unionVariantNode(node, valueOfNode);
  if (actual === undefined) return undefined;
  switch (actual.kind) {
  case 'array': return typeof key === 'number' ? actual.of : undefined;
  case 'object': return typeof key === 'string' && Object.hasOwn(actual.fields, key) ? actual.fields[key] : undefined;
  default: return undefined;
  }
};

const withDiscriminant = (node: IRSchemaNode, key: string | number): IRSchemaNode | undefined => {
  const unwrapped = node.kind === 'nullable' ? node.of : node;
  return unwrapped.kind === 'union' && key === unwrapped.discriminant ? discriminantNode : undefined;
};

export interface IRUnit {
  readonly kind: IRUnitKind;
  readonly path: IRPath;
}

interface Resolution {
  readonly node: IRSchemaNode;
  // The units the path passes through, outermost first, ending with the path itself when it is a unit.
  readonly units: readonly IRUnit[];
}

export const resolveIRPath = (path: IRPath, root: unknown): Resolution | undefined => {
  let node: IRSchemaNode = irSchema;
  let value = root;
  const prefix: (string | number)[] = [];
  const units: IRUnit[] = [];
  for (const key of path) {
    const next: IRSchemaNode | undefined = withDiscriminant(node, key) ?? childNode(node, key, value);
    if (next === undefined) return undefined;
    node = next;
    value = typeof value === 'object' && value !== null && Object.hasOwn(value, key)
      ? (value as Record<string | number, unknown>)[key]
      : undefined;
    prefix.push(key);
    const kind = unitKindOf(node);
    if (kind !== undefined) units.push({ kind, path: [...prefix] });
  }
  return { node, units };
};

export const irUnitChain = (path: IRPath, root: unknown): readonly IRUnit[] => resolveIRPath(path, root)?.units ?? [];

const unitAt = (path: IRPath, root: unknown): IRUnitKind | undefined => {
  const resolution = resolveIRPath(path, root);
  const last = resolution?.units.at(-1);
  return last !== undefined && last.path.length === path.length ? last.kind : undefined;
};

export const isIRItemPath = (path: IRPath, root: unknown): boolean => unitAt(path, root) === 'item';

export const isIRPartPath = (path: IRPath, root: unknown): boolean => unitAt(path, root) === 'part';

export const isIRAppendTarget = (path: IRPath, root: unknown): boolean => {
  const node = resolveIRPath(path, root)?.node;
  return node?.kind === 'string' && node.append === true;
};

export const isIRAbsentTarget = (path: IRPath, root: unknown): boolean => {
  const node = resolveIRPath(path, root)?.node;
  return node?.kind === 'string' && node.absent === true;
};

const WILDCARD = Symbol('index');
type TemplateSegment = string | typeof WILDCARD;

const findUnitTemplate = (node: IRSchemaNode, kind: IRUnitKind, prefix: readonly TemplateSegment[]): readonly TemplateSegment[] | undefined => {
  if (unitKindOf(node) === kind) return prefix;
  switch (node.kind) {
  case 'nullable': return findUnitTemplate(node.of, kind, prefix);
  case 'array': return findUnitTemplate(node.of, kind, [...prefix, WILDCARD]);
  case 'object':
    for (const [key, field] of Object.entries(node.fields)) {
      const found = findUnitTemplate(field, kind, [...prefix, key]);
      if (found !== undefined) return found;
    }
    return undefined;
  case 'union':
    for (const variant of Object.values(node.cases)) {
      const found = findUnitTemplate(variant, kind, prefix);
      if (found !== undefined) return found;
    }
    return undefined;
  default: return undefined;
  }
};

const unitTemplates = new Map<IRUnitKind, readonly TemplateSegment[]>();

// The units enclosing a unit, outermost first, followed by the unit itself.
const unitKindsAlong = (kind: IRUnitKind): readonly IRUnitKind[] => {
  const kinds: IRUnitKind[] = [];
  const visit = (node: IRSchemaNode): boolean => {
    const own = unitKindOf(node);
    if (own !== undefined) kinds.push(own);
    if (own === kind) return true;
    let found = false;
    switch (node.kind) {
    case 'nullable': found = visit(node.of); break;
    case 'array': found = visit(node.of); break;
    case 'object': found = Object.values(node.fields).some(visit); break;
    case 'union': found = Object.values(node.cases).some(visit); break;
    default:
    }
    if (!found && own !== undefined) kinds.pop();
    return found;
  };
  visit(irSchema);
  return kinds;
};

// The path of a unit from the indices of it and its enclosing units, outermost first.
export const irUnitPath = (kind: IRUnitKind, ...indices: readonly number[]): IRPath => {
  let template = unitTemplates.get(kind);
  if (template === undefined) {
    template = findUnitTemplate(irSchema, kind, []);
    if (template === undefined) throw new TypeError(`The IR schema has no ${kind} unit`);
    unitTemplates.set(kind, template);
  }
  let next = 0;
  const path = template.map(segment => segment === WILDCARD ? indices[next++] : segment);
  if (next !== indices.length) throw new TypeError(`IR ${kind} paths take ${next} indices, got ${indices.length}`);
  return path;
};

export const irItemPath = (choice: number, item: number): IRPath => irUnitPath('item', choice, item);

export const irPartPath = (choice: number, item: number, part: number): IRPath => irUnitPath('part', choice, item, part);

// An `<unit>_end` event names the unit it ends by the indices of that unit and the units around it.
export const irEndedUnit = (event: IREvent): IRUnit | undefined => {
  if (!event.type.endsWith('_end')) return undefined;
  const kind = event.type.slice(0, -'_end'.length) as IRUnitKind;
  const kinds = unitKindsAlong(kind);
  if (kinds.at(-1) !== kind) return undefined;
  return { kind, path: irUnitPath(kind, ...kinds.map(unit => (event as unknown as Record<string, number>)[unit])) };
};

// The units a record belongs to, innermost first.
export const irRecordOwnerPaths = (record: IRRecord, root: unknown): readonly IRPath[] => {
  if (record.type === 'write') return irUnitChain(record.path, root).map(unit => unit.path).reverse();
  const ended = irEndedUnit(record);
  return ended === undefined ? [] : [ended.path];
};
