/**
 * The flat wire name a namespaced callable gets on a protocol without
 * namespaces.
 *
 * Chat Completions and Messages address a callable by one bare name, so a
 * declaration that lives in a group has to be spelled out. Two steps are pure
 * functions of the pair — the name is cut to the 64 ASCII characters Chat
 * allows and every character it cannot carry becomes `_`:
 *
 * https://github.com/openai/openai-node/blob/61539248cbe04665de68a71e6fd878127ae4db87/src/resources/chat/completions/completions.ts
 *
 * What is not a function of the pair is the collision suffix: two different
 * groups can spell the same flat name, and which one gets `_2` depends on what
 * was allocated before it. That is why the caller walks the whole conversation
 * in one pass rather than mapping each declaration alone.
 */
export interface GroupedCallable {
  readonly namespace: string;
  readonly name: string;
}

/**
 * Assigns one flat name per grouped callable, in the order they are given.
 *
 * `reserved` holds the names the request already uses without a group; a
 * grouped callable must not take one of them, and must not take a name this
 * pass has already handed out.
 */
export const assignFlatNames = <T extends GroupedCallable>(
  callables: readonly T[],
  reserved: ReadonlySet<string>,
): Map<string, string> => {
  const taken = new Set(reserved);
  const nextSuffixes = new Map<string, number>();
  const assigned = new Map<string, string>();
  for (const { namespace, name } of callables) {
    const key = `${namespace}.${name}`;
    if (assigned.has(key)) continue;
    const scope = `${namespace.slice(0, 64)}_`.slice(0, 64);
    const base = `${scope}${name.slice(0, 64 - scope.length)}`.replaceAll(/[^a-zA-Z0-9_-]/g, '_');
    for (let suffix = 1; ; suffix++) {
      const ending = suffix === 1 ? '' : `_${suffix}`;
      const prefix = base.slice(0, 64 - ending.length);
      if (suffix > 1) {
        // Share cursors only when both the truncated prefix and suffix width match.
        const cursor = `${ending.length}:${prefix}`;
        const next = nextSuffixes.get(cursor);
        if (next !== undefined && next > suffix) { suffix = next - 1; continue; }
        nextSuffixes.set(cursor, suffix + 1);
      }
      const candidate = `${prefix}${ending}`;
      if (taken.has(candidate)) continue;
      taken.add(candidate);
      assigned.set(key, candidate);
      break;
    }
  }
  return assigned;
};
