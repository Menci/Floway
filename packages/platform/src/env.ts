export type EnvGetter = (name: string) => string | undefined;

let _getEnv: EnvGetter | null = null;

export const initEnv = (fn: EnvGetter): void => {
  _getEnv = fn;
};

// Returns `defaultValue` for variables the operator is allowed to leave unset.
// The EnvGetter contract is "missing → undefined"; any other failure (malformed
// value, binding lookup failure) propagates so we never silently default through
// an unexpected throw.
export const getEnvOptional = (name: string, defaultValue: string): string => {
  if (!_getEnv) throw new Error('Env not initialized — call initEnv() first');
  return _getEnv(name) ?? defaultValue;
};
