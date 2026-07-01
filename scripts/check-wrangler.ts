// Pre-deploy gate: wrangler.jsonc is gitignored, so the only place we can
// pin its shape is wrangler.example.jsonc. We compare the two structurally
// in both directions — every key/value in the example must match the real
// one exactly, and the real must not carry keys or bindings the example
// doesn't pin. Placeholders (`<YOUR_*>`) are the one relaxation: the real
// must override them with a concrete value. The one personal-only key the
// example is allowed to omit is listed in EXAMPLE_ONLY_OPTIONAL_KEYS below
// (currently just `account_id`, which is per-contributor and would leak
// into the checked-in example otherwise). Anything else the real config
// needs — extra bindings, extra compat flags, a `vars` block — has to
// land in the example first so every contributor and the deploy gate see
// the same Worker shape. The runtime also fails fast on missing bindings,
// but a 503 from a freshly published deploy is worse than a non-zero exit
// before publish.
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse, type ParseError } from 'jsonc-parser';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXAMPLE_PATH = resolve(ROOT, 'wrangler.example.jsonc');
const REAL_PATH = resolve(ROOT, 'wrangler.jsonc');

const PLACEHOLDER_RE = /^<YOUR_[A-Z0-9_]+>$/;
const isPlaceholder = (v: unknown): v is string => typeof v === 'string' && PLACEHOLDER_RE.test(v);

// Top-level keys the real config may carry without a matching example
// entry. Kept as narrow as possible — every addition weakens the gate.
const EXAMPLE_ONLY_OPTIONAL_KEYS = new Set(['account_id']);

interface Mismatch {
  path: string;
  reason: string;
}

const fmt = (v: unknown): string => JSON.stringify(v);

const isBindingArray = (arr: readonly unknown[]): arr is ReadonlyArray<Record<string, unknown>> =>
  arr.length > 0 && arr.every(
    e => typeof e === 'object' && e !== null && typeof (e as Record<string, unknown>).binding === 'string',
  );

const compare = (expected: unknown, actual: unknown, path: string, out: Mismatch[]): void => {
  if (isPlaceholder(expected)) {
    if (typeof actual !== 'string' || actual.length === 0 || isPlaceholder(actual)) {
      out.push({ path, reason: `placeholder ${expected} must be replaced with a concrete value, got ${fmt(actual)}` });
    }
    return;
  }

  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      out.push({ path, reason: `expected array, got ${fmt(actual)}` });
      return;
    }
    // Bindings (d1_databases, r2_buckets, kv_namespaces, ...) are identified
    // by their `binding` name, not array position. Match each example entry
    // to the real entry with the same binding, and reject any real entry
    // whose binding name the example doesn't pin.
    if (isBindingArray(expected)) {
      const expectedNames = new Set(expected.map(e => e.binding as string));
      for (const exp of expected) {
        const name = exp.binding as string;
        const match = actual.find(
          (a): a is Record<string, unknown> =>
            typeof a === 'object' && a !== null && (a as Record<string, unknown>).binding === name,
        );
        if (match === undefined) {
          out.push({ path: `${path}[binding=${name}]`, reason: 'binding entry missing' });
          continue;
        }
        compare(exp, match, `${path}[binding=${name}]`, out);
      }
      for (const act of actual) {
        if (typeof act !== 'object' || act === null) continue;
        const name = (act as Record<string, unknown>).binding;
        if (typeof name !== 'string') continue;
        if (!expectedNames.has(name)) {
          out.push({ path: `${path}[binding=${name}]`, reason: 'binding present in wrangler.jsonc but not in the example' });
        }
      }
      return;
    }
    if (expected.length !== actual.length) {
      out.push({ path, reason: `expected array of length ${expected.length}, got ${actual.length}` });
      return;
    }
    expected.forEach((v, i) => compare(v, actual[i], `${path}[${i}]`, out));
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
      compare(value, actualRecord[key], path === '' ? key : `${path}.${key}`, out);
    }
    for (const key of Object.keys(actualRecord)) {
      if (key in expectedRecord) continue;
      if (path === '' && EXAMPLE_ONLY_OPTIONAL_KEYS.has(key)) continue;
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

const parseJsonc = async (path: string): Promise<unknown> => {
  const text = await readFile(path, 'utf8');
  const errors: ParseError[] = [];
  const value = parse(text, errors);
  if (errors.length > 0) {
    console.error(`Failed to parse ${path}:`);
    for (const e of errors) console.error(`  ${JSON.stringify(e)}`);
    process.exit(1);
  }
  return value;
};

const [example, real] = await Promise.all([parseJsonc(EXAMPLE_PATH), parseJsonc(REAL_PATH)]);
const mismatches: Mismatch[] = [];
compare(example, real, '', mismatches);

if (mismatches.length > 0) {
  console.error('wrangler.jsonc drifted from wrangler.example.jsonc:');
  for (const m of mismatches) console.error(`  - ${m.path}: ${m.reason}`);
  console.error('Mirror wrangler.example.jsonc, filling in every <YOUR_*> placeholder with your own value.');
  process.exit(1);
}
