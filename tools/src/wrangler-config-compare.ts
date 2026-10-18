const PLACEHOLDER_RE = /^<YOUR_[A-Z0-9_]+>$/;
const REAL_ONLY_OPTIONAL_KEYS = new Set(['account_id']);
const DEPLOYMENT_SPECIFIC_KEYS = new Set(['observability']);

export interface WranglerConfigMismatch {
  path: string;
  reason: string;
}

const isPlaceholder = (value: unknown): value is string =>
  typeof value === 'string' && PLACEHOLDER_RE.test(value);

const fmt = (value: unknown): string => JSON.stringify(value);
const isArray = (value: unknown): value is readonly unknown[] => Array.isArray(value);

const isBindingArray = (arr: readonly unknown[]): arr is ReadonlyArray<Record<string, unknown>> =>
  arr.length > 0 && arr.every(
    entry => typeof entry === 'object' && entry !== null && typeof (entry as Record<string, unknown>).binding === 'string',
  );

const hasBinding = (value: unknown): value is Record<string, unknown> & { binding: string } =>
  typeof value === 'object' && value !== null && typeof (value as Record<string, unknown>).binding === 'string';

const isDeploymentSpecific = (path: string, key: string): boolean =>
  path === '' && DEPLOYMENT_SPECIFIC_KEYS.has(key);

const compare = (expected: unknown, actual: unknown, path: string, out: WranglerConfigMismatch[]): void => {
  if (isPlaceholder(expected)) {
    if (typeof actual !== 'string' || actual.trim().length === 0 || isPlaceholder(actual)) {
      out.push({ path, reason: `placeholder ${expected} must be replaced with a concrete value, got ${fmt(actual)}` });
    }
    return;
  }

  if (isArray(expected)) {
    if (!Array.isArray(actual)) {
      out.push({ path, reason: `expected array, got ${fmt(actual)}` });
      return;
    }
    if (isBindingArray(expected)) {
      const actualBindings = actual.filter(hasBinding);
      for (const [index, entry] of actual.entries()) {
        if (!hasBinding(entry)) out.push({ path: `${path}[${index}]`, reason: 'binding entry must be an object with a string binding' });
      }
      const duplicates = actualBindings
        .map(entry => entry.binding)
        .filter((name, index, names) => names.indexOf(name) !== index);
      for (const name of new Set(duplicates)) {
        out.push({ path: `${path}[binding=${name}]`, reason: 'binding appears more than once' });
      }
      const expectedNameList = expected.map(entry => entry.binding as string);
      const expectedDuplicates = expectedNameList.filter((name, index) => expectedNameList.indexOf(name) !== index);
      for (const name of new Set(expectedDuplicates)) {
        out.push({ path: `${path}[binding=${name}]`, reason: 'binding appears more than once in wrangler.example.jsonc' });
      }
      const expectedNames = new Set(expectedNameList);
      for (const exp of expected) {
        const name = exp.binding as string;
        const match = actualBindings.find(entry => entry.binding === name);
        if (match === undefined) {
          out.push({ path: `${path}[binding=${name}]`, reason: 'binding entry missing' });
          continue;
        }
        compare(exp, match, `${path}[binding=${name}]`, out);
      }
      for (const { binding: name } of actualBindings) {
        if (!expectedNames.has(name)) {
          out.push({ path: `${path}[binding=${name}]`, reason: 'binding present in wrangler.jsonc but not in the example' });
        }
      }
      return;
    }
    // Cloudflare states that run_worker_first pattern order is not significant:
    // https://developers.cloudflare.com/workers/static-assets/routing/worker-script/
    if (path === 'assets.run_worker_first') {
      const expectedStrings = expected.filter((value): value is string => typeof value === 'string');
      const expectedDuplicates = expectedStrings.filter((value, index) => expectedStrings.indexOf(value) !== index);
      for (const value of new Set(expectedDuplicates)) {
        out.push({ path, reason: `entry ${fmt(value)} appears more than once in wrangler.example.jsonc` });
      }
      const actualStrings = actual.filter((value): value is string => typeof value === 'string');
      for (const [index, value] of actual.entries()) {
        if (typeof value !== 'string') out.push({ path: `${path}[${index}]`, reason: `expected a string entry, got ${fmt(value)}` });
      }
      const duplicates = actualStrings.filter((value, index) => actualStrings.indexOf(value) !== index);
      for (const value of new Set(duplicates)) out.push({ path, reason: `entry ${fmt(value)} appears more than once` });
      const actualSet = new Set(actualStrings);
      for (const value of expectedStrings) {
        if (!actualSet.has(value)) out.push({ path, reason: `entry ${fmt(value)} missing` });
      }
      const expectedSet = new Set(expectedStrings);
      for (const value of actualStrings) {
        if (!expectedSet.has(value)) {
          out.push({ path, reason: `entry ${fmt(value)} present in wrangler.jsonc but not in the example` });
        }
      }
      return;
    }
    if (expected.length !== actual.length) {
      out.push({ path, reason: `expected array of length ${expected.length}, got ${actual.length}` });
      return;
    }
    expected.forEach((value, index) => compare(value, actual[index], `${path}[${index}]`, out));
    return;
  }

  if (expected !== null && typeof expected === 'object') {
    if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) {
      out.push({ path, reason: `expected object, got ${fmt(actual)}` });
      return;
    }
    const expectedRecord = expected as Record<string, unknown>;
    const actualRecord = actual as Record<string, unknown>;
    for (const [key, value] of Object.entries(expectedRecord)) {
      if (isDeploymentSpecific(path, key)) continue;
      compare(value, actualRecord[key], path === '' ? key : `${path}.${key}`, out);
    }
    for (const key of Object.keys(actualRecord)) {
      if (isDeploymentSpecific(path, key)) continue;
      if (key in expectedRecord) continue;
      if (path === '' && REAL_ONLY_OPTIONAL_KEYS.has(key)) continue;
      out.push({
        path: path === '' ? key : `${path}.${key}`,
        reason: 'key present in wrangler.jsonc but not in the example',
      });
    }
    return;
  }

  if (expected !== actual) {
    out.push({ path, reason: `expected ${fmt(expected)}, got ${fmt(actual)}` });
  }
};

export const findWranglerConfigMismatches = (example: unknown, real: unknown): WranglerConfigMismatch[] => {
  const mismatches: WranglerConfigMismatch[] = [];
  compare(example, real, '', mismatches);
  return mismatches;
};
