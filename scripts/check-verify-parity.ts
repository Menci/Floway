// A verification that exists in only one of the two places is invisible. Named
// in `.github/workflows/verify.yaml` alone, it cannot be reproduced locally and
// nobody knows it is there; chained from `verify` alone, no pull request ever
// runs it. `generate-assets --check` sat in the workflow with no root script
// for exactly this reason, so the two lists are derived and compared here
// rather than kept in step by hand.
//
// The comparison is over root script names, not over workflow entries. One
// matrix entry legitimately runs several scripts when they share expensive
// setup, and the workflow also runs scripts outside the matrix -- `typegen`
// prepares the generated route types every type-aware check depends on. What
// must hold is only that neither side names a script the other does not.
//
// The workflow is read with a regex instead of a YAML parser, as
// pnpm-workspace.yaml is in check-agents-md.ts.
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST_PATH = resolve(ROOT, 'package.json');
const WORKFLOW_PATH = resolve(ROOT, '.github/workflows/verify.yaml');
// A commented-out step is not a step, so `#` ends a line before it is scanned.
// The scan is deliberately unanchored: `verify` chains its scripts on a single
// line, so an anchored pattern would see only the first of them.
const SCRIPT_RUN = /\bpnpm run ([\w:-]+)/g;

const fail = (message: string): never => {
  throw new Error(`verify parity: ${message}`);
};

const scriptsRunBy = (source: string): Set<string> => {
  const executable = source.split('\n').map(line => line.split('#')[0]!).join('\n');
  return new Set([...executable.matchAll(SCRIPT_RUN)].map(([, name]) => name!));
};

const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8')) as {
  scripts: Record<string, string | undefined>;
};
const verifyCommand = manifest.scripts.verify ?? fail('package.json must define a `verify` script');
const workflow = await readFile(WORKFLOW_PATH, 'utf8');

const verifyScripts = scriptsRunBy(verifyCommand);
const workflowScripts = scriptsRunBy(workflow);

if (verifyScripts.size === 0) fail('`verify` must chain the repository checks through `pnpm run`');

for (const name of verifyScripts) {
  if (!manifest.scripts[name]) {
    fail(`\`verify\` chains \`${name}\`, which package.json does not define`);
  }
}

const missingFromWorkflow = [...verifyScripts].filter(name => !workflowScripts.has(name));
if (missingFromWorkflow.length > 0) {
  fail(`verify.yaml never runs ${JSON.stringify(missingFromWorkflow)}, which \`verify\` chains`);
}

const missingFromVerify = [...workflowScripts].filter(name => !verifyScripts.has(name));
if (missingFromVerify.length > 0) {
  fail(`\`verify\` omits ${JSON.stringify(missingFromVerify)}, which verify.yaml runs`);
}
