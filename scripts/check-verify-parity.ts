// A verification that exists in only one of the two places is invisible. Named
// in `.github/workflows/verify.yaml` alone, it cannot be reproduced locally and
// nobody knows it is there; chained from `verify` alone, no pull request ever
// runs it. Both lists are therefore derived and compared here rather than kept
// in step by hand.
//
// Recognising a verification is the harder half. A command that reaches one
// without going through a root script -- `pnpm --filter <pkg> run <script>`, a
// bare `jiti scripts/....ts`, a `vitest` invocation -- would contribute nothing
// to a scan that only knows `pnpm run`, so the two derived sets would agree
// while the workflow ran something `verify` does not. An unrecognised command
// is therefore an error rather than an empty contribution, on both sides, which
// is also what makes the `Reach every verification through a root script`
// clause of the AGENTS.md rule enforceable rather than merely stated.
//
// The comparison is over script names, not over workflow entries: one matrix
// entry legitimately chains several scripts when they share expensive setup,
// and the workflow runs scripts outside the matrix -- `typegen` prepares the
// generated route types every type-aware check depends on.
//
// Comparing the two lists cannot see a verification absent from both, so the
// root manifest is swept as well. Which scripts are verifications is read off
// their names, the same convention their kind prefixes already encode; the
// sweep runs one way only, because `verify` also chains setup (`typegen`) and a
// build (`build:web`) that no naming rule marks as verifications.
//
// The workflow is read with a regex instead of a YAML parser, as
// pnpm-workspace.yaml is in check-agents-md.ts. Every `run:` value is recovered
// whole, so a form the parser was not built for (a block scalar, say) fails
// loudly instead of being silently skipped.
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST_PATH = resolve(ROOT, 'package.json');
const WORKFLOW_PATH = resolve(ROOT, '.github/workflows/verify.yaml');
// A `run:` on a commented line is not a step: `\s` cannot cross the `#`.
const RUN_VALUE = /^\s*run:\s*(\S.*?)\s*$/gm;
const SCRIPT_CALL = /^pnpm run ([\w:-]+)$/;
// A root script whose name states a kind of verification. `lint` and `typecheck`
// are exact so that `lint:fix`, which repairs rather than verifies, stays out.
const VERIFICATION_SCRIPT = /^(?:lint|typecheck|test|(?:check|test)(?::[\w-]+)+)$/;
// Provisioning the runner is not a verification, and the matrix dispatch only
// forwards an entry recovered above.
const SETUP_COMMANDS = new Set([
  'corepack enable',
  'pnpm install --frozen-lockfile',
  '${{ matrix.check.run }}',
]);

const fail = (message: string): never => {
  throw new Error(`verify parity: ${message}`);
};

const scriptsCalledBy = (command: string, origin: string): string[] =>
  command.split('&&').map(segment => {
    const name = SCRIPT_CALL.exec(segment.trim())?.[1];
    return name ?? fail(`${origin} runs ${JSON.stringify(segment.trim())}, which is not \`pnpm run <script>\``);
  });

const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8')) as {
  scripts: Record<string, string | undefined>;
};
const verifyCommand = manifest.scripts.verify ?? fail('package.json must define a `verify` script');
const workflow = await readFile(WORKFLOW_PATH, 'utf8');

const verifyScripts = new Set(scriptsCalledBy(verifyCommand, '`verify`'));
const workflowScripts = new Set(
  [...workflow.matchAll(RUN_VALUE)]
    .map(([, command]) => command!)
    .filter(command => !SETUP_COMMANDS.has(command))
    .flatMap(command => scriptsCalledBy(command, 'verify.yaml')),
);

for (const name of verifyScripts) {
  if (!manifest.scripts[name]) {
    fail(`\`verify\` chains \`${name}\`, which package.json does not define`);
  }
}

const unchained = Object.keys(manifest.scripts).filter(
  name => VERIFICATION_SCRIPT.test(name) && !verifyScripts.has(name),
);
if (unchained.length > 0) {
  fail(`\`verify\` never chains ${JSON.stringify(unchained)}, which package.json names as verifications`);
}

const missingFromWorkflow = [...verifyScripts].filter(name => !workflowScripts.has(name));
if (missingFromWorkflow.length > 0) {
  fail(`verify.yaml never runs ${JSON.stringify(missingFromWorkflow)}, which \`verify\` chains`);
}

const missingFromVerify = [...workflowScripts].filter(name => !verifyScripts.has(name));
if (missingFromVerify.length > 0) {
  fail(`\`verify\` omits ${JSON.stringify(missingFromVerify)}, which verify.yaml runs`);
}
