import { TranslatorInputError } from '../../translator-input-error.ts';

const ENVELOPE_KEY = 'arguments';
const ROOT_COMBINATORS = ['oneOf', 'anyOf', 'allOf'] as const;
const ENVELOPE_POINTER = '#/properties/arguments';
const SCHEMA_MAP_FIELDS = ['$defs', 'definitions', 'properties', 'patternProperties', 'dependentSchemas'] as const;
const SCHEMA_ARRAY_FIELDS = ['allOf', 'anyOf', 'oneOf', 'prefixItems'] as const;
const SCHEMA_FIELDS = [
  'additionalItems', 'additionalProperties', 'contains', 'contentSchema', 'else', 'if', 'items',
  'not', 'propertyNames', 'then', 'unevaluatedItems', 'unevaluatedProperties',
] as const;

export const hasRootToolSchemaCombinator = (schema: Record<string, unknown>): boolean =>
  ROOT_COMBINATORS.some(key => Array.isArray(schema[key]));

const rewriteLocalReference = (reference: string): string => {
  if (reference === '#') return ENVELOPE_POINTER;
  if (reference.startsWith('#/')) return `${ENVELOPE_POINTER}${reference.slice(1)}`;
  return reference;
};

const rewriteSchema = (value: unknown, rewriteEnabled: boolean): unknown => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return structuredClone(value);
  const source = value as Record<string, unknown>;
  // A nested `$id` owns a new resource. Its refs keep their local base and the
  // complete resource can be copied without inspecting instance-valued data.
  if (!rewriteEnabled || typeof source.$id === 'string') return structuredClone(source);

  const rewritten = structuredClone(source);
  if (typeof source.$ref === 'string') rewritten.$ref = rewriteLocalReference(source.$ref);
  if (typeof source.$dynamicRef === 'string') rewritten.$dynamicRef = rewriteLocalReference(source.$dynamicRef);
  for (const field of SCHEMA_FIELDS) {
    if (source[field] !== undefined) rewritten[field] = rewriteSchema(source[field], true);
  }
  for (const field of SCHEMA_ARRAY_FIELDS) {
    if (Array.isArray(source[field])) rewritten[field] = source[field].map(schema => rewriteSchema(schema, true));
  }
  for (const field of SCHEMA_MAP_FIELDS) {
    const schemas = source[field];
    if (typeof schemas !== 'object' || schemas === null || Array.isArray(schemas)) continue;
    rewritten[field] = Object.fromEntries(Object.entries(schemas).map(([key, schema]) => [key, rewriteSchema(schema, true)]));
  }
  const dependencies = source.dependencies;
  if (typeof dependencies === 'object' && dependencies !== null && !Array.isArray(dependencies)) {
    rewritten.dependencies = Object.fromEntries(Object.entries(dependencies).map(([key, dependency]) => [
      key,
      Array.isArray(dependency) ? structuredClone(dependency) : rewriteSchema(dependency, true),
    ]));
  }
  return rewritten;
};

const hasRecursiveKeyword = (value: unknown): boolean => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const source = value as Record<string, unknown>;
  if (source.$recursiveRef !== undefined || source.$recursiveAnchor !== undefined) return true;
  return SCHEMA_FIELDS.some(field => hasRecursiveKeyword(source[field]))
    || SCHEMA_ARRAY_FIELDS.some(field => Array.isArray(source[field]) && source[field].some(hasRecursiveKeyword))
    || SCHEMA_MAP_FIELDS.some(field => {
      const schemas = source[field];
      return typeof schemas === 'object' && schemas !== null && !Array.isArray(schemas)
        && Object.values(schemas).some(hasRecursiveKeyword);
    })
    || (typeof source.dependencies === 'object' && source.dependencies !== null && !Array.isArray(source.dependencies)
      && Object.values(source.dependencies).some(dependency => !Array.isArray(dependency) && hasRecursiveKeyword(dependency)));
};

// Anthropic Messages accepts JSON Schema combinators below the input_schema
// root but rejects them at the root. Preserve the complete original schema
// under one object property and retarget document-local JSON Pointers to that
// location. Anchors, external references, and nested schema resources retain
// their original reference bases.
// https://platform.claude.com/docs/en/agents-and-tools/tool-use/implement-tool-use#specifying-client-tools
export const envelopeRootToolSchema = (schema: Record<string, unknown>): Record<string, unknown> => {
  if (schema.$id !== undefined || schema.$schema !== undefined || hasRecursiveKeyword(schema)) {
    throw new TranslatorInputError('Cannot envelope a root-union tool schema with a root resource or recursive-schema keywords.');
  }
  const nested = rewriteSchema(schema, true);
  return {
    type: 'object',
    properties: { [ENVELOPE_KEY]: nested },
    required: [ENVELOPE_KEY],
    additionalProperties: false,
  };
};

export const envelopeToolArguments = (input: Record<string, unknown>): Record<string, unknown> => ({
  [ENVELOPE_KEY]: input,
});

export const unwrapToolArguments = (wrapped: string): string => {
  try {
    const parsed = JSON.parse(wrapped) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || !(ENVELOPE_KEY in parsed)) return wrapped;
    const encoded = JSON.stringify((parsed as Record<string, unknown>)[ENVELOPE_KEY]);
    return encoded ?? wrapped;
  } catch {
    return wrapped;
  }
};
