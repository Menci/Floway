// wrangler.jsonc is contributor-owned and gitignored. The checked-in example
// defines the shared Worker topology, while concrete placeholder replacements,
// account selection, and observability policy remain deployment-local.
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse, type ParseError } from 'jsonc-parser';

import { findWranglerConfigMismatches } from '../tools/src/wrangler-config-compare.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXAMPLE_PATH = resolve(ROOT, 'wrangler.example.jsonc');
const REAL_PATH = resolve(ROOT, 'wrangler.jsonc');

const parseJsonc = async (path: string): Promise<unknown> => {
  const text = await readFile(path, 'utf8');
  const errors: ParseError[] = [];
  const value = parse(text, errors);
  if (errors.length > 0) {
    throw new Error(`Failed to parse ${path}: ${errors.map(error => JSON.stringify(error)).join(', ')}`);
  }
  return value;
};

const [example, real] = await Promise.all([parseJsonc(EXAMPLE_PATH), parseJsonc(REAL_PATH)]);
const mismatches = findWranglerConfigMismatches(example, real);

if (mismatches.length > 0) {
  console.error('wrangler.jsonc drifted from wrangler.example.jsonc:');
  for (const m of mismatches) console.error(`  - ${m.path}: ${m.reason}`);
  console.error('Mirror wrangler.example.jsonc, filling in every <YOUR_*> placeholder with your own value.');
  process.exit(1);
}
