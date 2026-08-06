import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from 'vitest';

import { SETUP_BASH_CODEX } from '../../../src/script-assets.generated.ts';

const functionStart = SETUP_BASH_CODEX.indexOf('_codex_kill_group() {');
const functionEnd = SETUP_BASH_CODEX.indexOf('\n\n# Read newline-delimited JSON-RPC', functionStart);
if (functionStart < 0 || functionEnd < 0) throw new Error('could not locate _codex_kill_group in the generated Bash installer');
const CODEX_KILL_GROUP = SETUP_BASH_CODEX.slice(functionStart, functionEnd);

const runBash = (source: string, args: string[], timeout: number) => spawnSync(
  '/bin/bash',
  ['-c', source, 'codex-shutdown-test', ...args],
  { encoding: 'utf8', killSignal: 'SIGKILL', timeout },
);

const resultDetails = (result: ReturnType<typeof runBash>): string =>
  `${result.error?.stack ?? ''}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;

const readPid = (path: string): number | null => {
  if (!existsSync(path)) return null;
  const pid = Number(readFileSync(path, 'utf8').trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
};

const processIsRunning = (pid: number): boolean => {
  const state = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
  return state !== '' && !state.startsWith('Z');
};

const killProcess = (pid: number, group = false): void => {
  try {
    process.kill(group ? -pid : pid, 'SIGKILL');
  } catch {
    // The shutdown path already removed it.
  }
};

test('Codex Bash shutdown reaps a clean app-server without waiting for its watchdog grace', () => {
  const root = mkdtempSync(join(tmpdir(), 'floway-codex-clean-shutdown.'));
  try {
    const result = runBash(`
${CODEX_KILL_GROUP}
SETUP_TMPDIR=$1
TEST_SLEEP_FIFO="$SETUP_TMPDIR/sleep"
mkfifo "$TEST_SLEEP_FIFO"
sleep() { IFS= read -r _ < "$TEST_SLEEP_FIFO"; }
set -m
( exit 0 ) &
pid=$!
set +m
_codex_kill_group "$pid" "$SETUP_TMPDIR/kill-started"
`, [root], 2_000);

    expect(result.error, resultDetails(result)).toBeUndefined();
    expect(result.status, resultDetails(result)).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Codex Bash shutdown sends TERM then KILL to a stubborn app-server process group', () => {
  const root = mkdtempSync(join(tmpdir(), 'floway-codex-stubborn-shutdown.'));
  const rootScript = join(root, 'root.sh');
  const childScript = join(root, 'child.sh');
  const rootPidPath = join(root, 'root.pid');
  const childPidPath = join(root, 'child.pid');
  const rootTermPath = join(root, 'root.term');
  const childTermPath = join(root, 'child.term');

  writeFileSync(childScript, `#!/bin/bash
trap 'printf "term\\n" > "$CHILD_TERM_FILE"' TERM
printf '%s\\n' "$$" > "$CHILD_PID_FILE"
while :; do /bin/sleep 10; done
`);
  writeFileSync(rootScript, `#!/bin/bash
trap 'printf "term\\n" > "$ROOT_TERM_FILE"' TERM
/bin/bash "$STUBBORN_CHILD" &
while [ ! -s "$CHILD_PID_FILE" ]; do /bin/sleep 0.01; done
while :; do /bin/sleep 10; done
`);

  const result = runBash(`
${CODEX_KILL_GROUP}
SETUP_TMPDIR=$1
sleep() { /bin/sleep 0.05; }
set -m
ROOT_TERM_FILE=$4 CHILD_TERM_FILE=$5 CHILD_PID_FILE=$3 STUBBORN_CHILD=$6 /bin/bash "$7" &
pid=$!
set +m
printf '%s\n' "$pid" > "$2"
_codex_kill_group "$pid" "$SETUP_TMPDIR/kill-started"
`, [root, rootPidPath, childPidPath, rootTermPath, childTermPath, childScript, rootScript], 5_000);

  const rootPid = readPid(rootPidPath);
  const childPid = readPid(childPidPath);
  const rootRunning = rootPid === null || processIsRunning(rootPid);
  const childRunning = childPid === null || processIsRunning(childPid);
  try {
    expect(result.error, resultDetails(result)).toBeUndefined();
    expect(result.status, resultDetails(result)).toBe(0);
    expect(rootPid).not.toBeNull();
    expect(childPid).not.toBeNull();
    expect(existsSync(rootTermPath)).toBe(true);
    expect(existsSync(childTermPath)).toBe(true);
    expect(rootRunning).toBe(false);
    expect(childRunning).toBe(false);
  } finally {
    if (rootPid !== null) killProcess(rootPid, true);
    if (childPid !== null) killProcess(childPid);
    rmSync(root, { recursive: true, force: true });
  }
});
