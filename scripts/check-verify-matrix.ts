// A check that exists in only one of the two places is invisible. Listed in
// `.github/workflows/verify.yaml` alone, it cannot be reproduced locally and
// nobody knows it is there; chained from `verify` alone, no pull request ever
// runs it. `generate-assets --check` sat in the workflow with no root script
// for exactly this reason, so the two lists are derived and compared here
// rather than kept in step by hand.
//
// The comparison is over root script names, not over matrix entries: one entry
// legitimately runs several scripts when they share expensive setup, as
// `build:web` and `check:web-build-output` share one build of the dashboard.
//
// The workflow is read with a regex instead of a YAML parser, as
// pnpm-workspace.yaml is in check-agents-md.ts. The matrix block is a fixed
// shape this repository controls, and a change to that shape fails here rather
// than passing quietly.
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST_PATH = resolve(ROOT, 'package.json');
const WORKFLOW_PATH = resolve(ROOT, '.github/workflows/verify.yaml');
const MATRIX_BLOCK = /^ {8}check:\n((?: {10}.+\n)+)/m;
const SCRIPT_RUN = /\bpnpm run ([\w:-]+)/g;

const fail = (message: string): never => {
  throw new Error(`verify coverage: ${message}`);
};

const scriptsRunBy = (command: string): Set<string> =>
  new Set([...command.matchAll(SCRIPT_RUN)].map(([, name]) => name!));

const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8')) as {
  scripts: Record<string, string | undefined>;
};
const verifyCommand = manifest.scripts.verify ?? fail('package.json must define a `verify` script');

const workflow = await readFile(WORKFLOW_PATH, 'utf8');
const matrixBlock = MATRIX_BLOCK.exec(workflow)?.[1]
  ?? fail('verify.yaml must declare a `check` matrix indented under `strategy.matrix`');

const chained = scriptsRunBy(verifyCommand);
const covered = scriptsRunBy(matrixBlock);

for (const name of chained) {
  if (!manifest.scripts[name]) fail(`\`verify\` chains \`${name}\`, which package.json does not define`);
}

const uncovered = [...chained].filter(name => !covered.has(name));
if (uncovered.length > 0) {
  fail(`verify.yaml runs no check for ${JSON.stringify(uncovered)}, which \`verify\` chains`);
}

const unchained = [...covered].filter(name => !chained.has(name));
if (unchained.length > 0) {
  fail(`\`verify\` omits ${JSON.stringify(unchained)}, which verify.yaml runs`);
}
