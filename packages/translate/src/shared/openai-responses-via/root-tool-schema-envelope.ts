const ENVELOPE_KEY = 'arguments';
const ROOT_COMBINATORS = ['oneOf', 'anyOf', 'allOf'] as const;
const REFERENCE_FIELDS = ['$ref', '$recursiveRef', '$dynamicRef'] as const;
const ENVELOPE_POINTER = '#/properties/arguments';

export const hasRootToolSchemaCombinator = (schema: Record<string, unknown>): boolean =>
  ROOT_COMBINATORS.some(key => Array.isArray(schema[key]));

const rewriteLocalReference = (reference: string): string => {
  if (reference === '#') return ENVELOPE_POINTER;
  if (reference.startsWith('#/')) return `${ENVELOPE_POINTER}${reference.slice(1)}`;
  return reference;
};

const rewriteLocalReferences = (value: unknown, rewriteEnabled: boolean): unknown => {
  if (Array.isArray(value)) return value.map(item => rewriteLocalReferences(item, rewriteEnabled));
  if (typeof value !== 'object' || value === null) return value;

  const source = value as Record<string, unknown>;
  // A nested `$id` starts a new schema resource. Fragment references below it
  // resolve against that resource and must not inherit the outer envelope path.
  const rewriteChildren = rewriteEnabled && typeof source.$id !== 'string';
  const rewritten: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(source)) {
    rewritten[key] = rewriteChildren && REFERENCE_FIELDS.includes(key as typeof REFERENCE_FIELDS[number]) && typeof child === 'string'
      ? rewriteLocalReference(child)
      : rewriteLocalReferences(child, rewriteChildren);
  }
  return rewritten;
};

// Anthropic Messages accepts JSON Schema combinators below the input_schema
// root but rejects them at the root. Preserve the complete original schema
// under one object property and retarget document-local JSON Pointers to that
// location. Anchors, external references, and nested schema resources retain
// their original reference bases.
// https://platform.claude.com/docs/en/agents-and-tools/tool-use/implement-tool-use#specifying-client-tools
export const envelopeRootToolSchema = (schema: Record<string, unknown>): Record<string, unknown> => {
  const nested = rewriteLocalReferences(structuredClone(schema), true);
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
