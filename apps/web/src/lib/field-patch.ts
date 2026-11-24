// An editor patch names each field it touches, and `undefined` clears an
// optional field. Only optional fields admit `undefined`, so a patch cannot
// clear a field the value requires.
export type FieldPatch<T> = { [K in keyof T]?: T[K] | ({} extends Pick<T, K> ? undefined : never) };

export const applyFieldPatch = <T extends object>(value: T, patch: FieldPatch<T>): T => {
  const next: Record<string, unknown> = { ...value as Record<string, unknown> };
  for (const [key, item] of Object.entries(patch)) {
    if (item === undefined) delete next[key];
    else next[key] = item;
  }
  return next as T;
};
